import { removeSession } from "../../../../lib/auth";
import { api, json, sameOrigin } from "../../_shared";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return api(async () => {
    sameOrigin(request);
    const response = json({ ok: true });
    response.headers.set("Set-Cookie", await removeSession(request));
    return response;
  }, request);
}
