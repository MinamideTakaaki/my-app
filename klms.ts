import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { chromium, request as playwrightRequest } from "playwright-core";

const KLMS_BASE_URL = "https://lms.keio.jp";
const LOGIN_SUCCESS_URL_PATTERN = /^https:\/\/lms\.keio\.jp\/\?login_success=1/;

const SESSION_DIR = path.join(process.cwd(), "klms-sessions");
if (!fs.existsSync(SESSION_DIR)) {
  fs.mkdirSync(SESSION_DIR);
}

function getEncryptionKey(): Buffer {
  const secret = process.env.KLMS_ENCRYPTION_KEY;
  if (!secret) {
    throw new Error("KLMS_ENCRYPTION_KEY is not set in .env");
  }
  return crypto.createHash("sha256").update(secret).digest();
}

function sessionFilePath(userId: number): string {
  return path.join(SESSION_DIR, `${userId}.enc`);
}

function encrypt(text: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

function decrypt(data: string): string {
  const buffer = Buffer.from(data, "base64");
  const iv = buffer.subarray(0, 12);
  const authTag = buffer.subarray(12, 28);
  const encrypted = buffer.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", getEncryptionKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

export function hasKlmsSession(userId: number): boolean {
  return fs.existsSync(sessionFilePath(userId));
}

// Opens a real, visible Edge window so the user can complete login
// (including Okta Verify / passkey) themselves. Runs in the background;
// callers should not await this from an HTTP request handler.
export async function connectKlms(userId: number): Promise<void> {
  const browser = await chromium.launch({ channel: "msedge", headless: false });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(KLMS_BASE_URL);
    await page.waitForURL(LOGIN_SUCCESS_URL_PATTERN, { timeout: 5 * 60 * 1000 });

    const storageState = await context.storageState();
    fs.writeFileSync(sessionFilePath(userId), encrypt(JSON.stringify(storageState)));
  } finally {
    await browser.close();
  }
}

type PlannerItem = {
  plannable_id: number;
  plannable_type: string;
  plannable_date: string | null;
  plannable: { title?: string; name?: string };
};

export async function fetchKlmsAssignments(
  userId: number
): Promise<{ klmsId: string; title: string; dueDate: Date | null }[]> {
  const storageState = JSON.parse(decrypt(fs.readFileSync(sessionFilePath(userId), "utf8")));
  const context = await playwrightRequest.newContext({ storageState, baseURL: KLMS_BASE_URL });
  try {
    const response = await context.get("/api/v1/planner/items?per_page=50");
    if (!response.ok()) {
      throw new Error(`KLMS API request failed: ${response.status()}`);
    }
    const items: PlannerItem[] = await response.json();
    return items.map((item) => ({
      klmsId: `${item.plannable_type}-${item.plannable_id}`,
      title: item.plannable.title ?? item.plannable.name ?? "(無題の課題)",
      dueDate: item.plannable_date ? new Date(item.plannable_date) : null,
    }));
  } finally {
    await context.dispose();
  }
}
