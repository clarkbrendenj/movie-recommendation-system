import { parseArtworkIds } from '../../../lib/tmdb-provider.mjs';
import { titleDetails } from '../../../lib/server-title-details';

export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  let ids: number[];
  try { ids = parseArtworkIds(new URL(request.url).searchParams.get('ids')); }
  catch { return Response.json({ error: 'Choose one to six valid catalog IDs.' }, { status: 400, headers: { 'Cache-Control': 'no-store' } }); }
  try {
    return Response.json(await titleDetails(ids, new URL(request.url).origin), { headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  } catch {
    // Optional metadata must never break recommendations or reveal provider credentials.
    return Response.json({ configured: false, items: {}, unavailable: true }, { headers: { 'Cache-Control': 'no-store' } });
  }
}
