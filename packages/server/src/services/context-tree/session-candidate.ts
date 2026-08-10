import {
  type ContextSessionCandidateIssueRequest,
  contextSessionCandidateIssueRequestSchema,
} from "@first-tree/shared";
import { jwtVerify, SignJWT } from "jose";
import { UnauthorizedError } from "../../errors.js";

const TOKEN_TYPE = "context_session_candidate";
const TOKEN_TTL = "24h";

export async function issueContextSessionCandidate(
  jwtSecret: string,
  userId: string,
  request: ContextSessionCandidateIssueRequest,
): Promise<string> {
  const input = contextSessionCandidateIssueRequestSchema.parse(request);
  return new SignJWT({
    type: TOKEN_TYPE,
    provider: input.provider,
    project: input.project,
    organizationId: input.organizationId,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(TOKEN_TTL)
    .sign(new TextEncoder().encode(jwtSecret));
}

export async function verifyContextSessionCandidate(
  jwtSecret: string,
  userId: string,
  receipt: string,
): Promise<ContextSessionCandidateIssueRequest> {
  try {
    const verified = await jwtVerify(receipt, new TextEncoder().encode(jwtSecret), {
      algorithms: ["HS256"],
      subject: userId,
    });
    if (verified.payload.type !== TOKEN_TYPE) throw new Error("wrong token type");
    return contextSessionCandidateIssueRequestSchema.parse({
      schemaVersion: 1,
      provider: verified.payload.provider,
      project: verified.payload.project,
      organizationId: verified.payload.organizationId,
    });
  } catch (error) {
    throw new UnauthorizedError("Invalid or expired Context session candidate receipt.", {
      "context.session_candidate.reason": error instanceof Error ? error.name : "verification_failed",
    });
  }
}
