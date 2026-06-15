import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  parseMemberFormConfig,
  ALWAYS_ON_FIELDS,
  type MemberFormFieldKey,
} from "@/lib/memberForm";

const FIELD_KEYS: readonly string[] = [
  "athleteName",
  "email",
  "phone",
  "dateOfBirth",
  "gender",
  "streetAddress",
  "city",
  "state",
  "zipCode",
  "status",
  "tags",
  "notes",
  "isMinor",
  "profileImageUrl",
  "guardianRelationship",
];

// GET /api/club/member-form
// Anyone in the club can read so the Add Member modal honors it.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const club = await prisma.club.findUnique({
    where: { id: session.user.clubId },
    select: { memberFormConfig: true },
  });

  return NextResponse.json({
    config: parseMemberFormConfig(club?.memberFormConfig),
    isCustomized: club?.memberFormConfig != null,
  });
}

const writeSchema = z.object({
  enabledFields:  z.array(z.string()),
  requiredFields: z.array(z.string()),
});

// PUT /api/club/member-form — owner/staff only
export async function PUT(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== "OWNER" && session.user.role !== "STAFF")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const data = writeSchema.parse(await req.json());
    const validKeys = new Set(FIELD_KEYS);
    const enabled = (data.enabledFields as MemberFormFieldKey[]).filter((k) => validKeys.has(k));
    const required = (data.requiredFields as MemberFormFieldKey[]).filter((k) => validKeys.has(k));

    const enabledSet = new Set<MemberFormFieldKey>([...enabled, ...ALWAYS_ON_FIELDS]);
    const requiredSet = new Set<MemberFormFieldKey>(
      required.filter((k) => enabledSet.has(k)).concat(["athleteName"])
    );

    const cfg = {
      enabledFields:  Array.from(enabledSet),
      requiredFields: Array.from(requiredSet),
    };

    await prisma.club.update({
      where: { id: session.user.clubId },
      data:  { memberFormConfig: cfg },
    });

    return NextResponse.json({ config: cfg });
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors }, { status: 400 });
    console.error(err); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
