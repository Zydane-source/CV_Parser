import { z } from "zod";
import { handler, ok, parseQuery } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { getUserConnection } from "@/services/google-drive/oauth";
import { listFolders, searchFolders } from "@/services/google-drive/files";

export const dynamic = "force-dynamic";

const schema = z.object({ parent: z.string().max(200).optional(), q: z.string().max(100).optional() });

/** GET /api/google-drive/folders?parent=root | ?q=Recruitment – folder picker. */
export const GET = handler(async (req: Request) => {
  const user = await requireUser();
  const { parent, q } = parseQuery(req, schema);
  const conn = await getUserConnection(user.id);
  if (!conn) throw new AppError("Google Drive is not connected", { status: 400, code: "GOOGLE_NOT_CONNECTED" });
  const folders = q ? await searchFolders(conn.id, q) : await listFolders(conn.id, parent || "root");
  return ok({ folders });
});
