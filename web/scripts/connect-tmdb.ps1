# Run from the repository root. No secret is accepted as an argument or written to disk.
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$webRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $webRoot '..'))
$connector = Join-Path $PSScriptRoot 'connect-tmdb.mjs'
$preferredNode = Join-Path $projectRoot 'data\app-tools\node-v22.23.4-win-x64\node.exe'
$nodePath = $null
$tokenPointer = [IntPtr]::Zero
$secureToken = $null
$plainToken = $null

function Invoke-Connector {
    param([bool]$CheckOnly, [string]$Secret)
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = $nodePath
    $start.WorkingDirectory = $webRoot
    # File paths are fixed, validated local paths. Windows file names cannot contain quotes.
    if ($connector.Contains('"')) { throw 'Invalid connector path.' }
    $start.Arguments = '"' + $connector + '"'
    if ($CheckOnly) { $start.Arguments += ' --check-target' }
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($name in @('TMDB_API_READ_TOKEN', 'NODE_OPTIONS', 'NODE_DEBUG', 'NODE_DEBUG_NATIVE', 'NODE_TLS_REJECT_UNAUTHORIZED')) {
        $start.EnvironmentVariables.Remove($name)
    }
    $child = New-Object System.Diagnostics.Process
    $child.StartInfo = $start
    try {
        if (-not $child.Start()) { throw 'Connector could not start.' }
        $outputTask = $child.StandardOutput.ReadToEndAsync()
        $errorTask = $child.StandardError.ReadToEndAsync()
        if (-not $CheckOnly) { $child.StandardInput.WriteLine($Secret) }
        $child.StandardInput.Close()
        $child.WaitForExit()
        # Never relay raw child output: upstream errors can include request details.
        [void]$outputTask.GetAwaiter().GetResult()
        [void]$errorTask.GetAwaiter().GetResult()
        return $child.ExitCode
    }
    finally {
        $Secret = $null
        $child.Dispose()
    }
}

try {
    if (Test-Path -LiteralPath $preferredNode -PathType Leaf) {
        $nodePath = $preferredNode
    } else {
        $nodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($nodeCommand) { $nodePath = $nodeCommand.Source }
    }
    if (-not $nodePath -or -not (Test-Path -LiteralPath $connector -PathType Leaf)) {
        throw 'Node or the connector is unavailable.'
    }
    $preflight = Invoke-Connector -CheckOnly $true
    if ($preflight -ne 0) {
        [Console]::Error.WriteLine('Afterglow setup verification failed. Check the existing deployment configuration and Node/Wrangler installation.')
        exit 10
    }
    Write-Host 'Target: https://afterglow.clarkbrendenj.workers.dev'
    Write-Host 'Use the TMDB API Read Access Token from your TMDB API settings, not the API key.'
    $secureToken = Read-Host 'Paste the TMDB API Read Access Token (hidden)' -AsSecureString
    $tokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
    $plainToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPointer)
    Write-Host 'Verifying TMDB access and storing the encrypted Afterglow Worker secret...'
    $result = Invoke-Connector -CheckOnly $false -Secret $plainToken
    switch ($result) {
        0 { Write-Host 'Connected. TMDB verified and its token stored in Cloudflare for Afterglow.' }
        10 { [Console]::Error.WriteLine('Afterglow setup verification failed. Nothing was sent to another app.') }
        11 { [Console]::Error.WriteLine('Use the TMDB API Read Access Token, not the API key. Nothing was stored.') }
        12 { [Console]::Error.WriteLine('TMDB verification failed. Check the token and your connection, then try again. Nothing was stored.') }
        default { [Console]::Error.WriteLine('Cloudflare did not confirm storage. Check your existing Wrangler sign-in and try again.') }
    }
    exit $result
}
catch {
    [Console]::Error.WriteLine('The TMDB connection could not finish. Check the local Afterglow setup and try again.')
    exit 1
}
finally {
    $plainToken = $null
    if ($tokenPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPointer)
        $tokenPointer = [IntPtr]::Zero
    }
    if ($null -ne $secureToken) { $secureToken.Dispose() }
}
