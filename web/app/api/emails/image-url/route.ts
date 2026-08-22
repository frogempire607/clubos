import { NextResponse } from "next/server";
import { z } from "zod";
import { formatZodError } from "@/lib/zodErrors";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { buildEmailImageUrl, isEmailImageSigningConfigured } from "@/lib/emailImages";

// POST /api/emails/image-url
//
// Given an UploadedFile.id the composer just uploaded, returns the
// unauthenticated signed URL suitable for embedding in an email body.
// The composer stores this URL on the ImageBlock.src field before the
// blocks JSON is written to the server — the send pipeline then treats
// it as a plain external URL.
//
// Auth: session-required + club-scoped. Only IMAGE-kind files. The signing
// itself is done server-side so the secret never touches the browser.

const schema = z.object({
  fileId: z.string().min(1),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!isEmailImageSigningConfigured()) {
    return NextResponse.json(
      { error: "Email image signing is not configured. Set EMAIL_IMAGE_SECRET before embedding images in email." },
      { status: 503 },
    );
  }

  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err) }, { status: 400 });
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  const file = await prisma.uploadedFile.findUnique({
    where: { id: body.fileId },
    select: { clubId: true, kind: true },
  });
  if (!file) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (file.clubId !== session.user.clubId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (file.kind !== "IMAGE") {
    return NextResponse.json({ error: "Only images can be signed for email embed." }, { status: 400 });
  }

  return NextResponse.json({ url: buildEmailImageUrl(body.fileId) });
}
