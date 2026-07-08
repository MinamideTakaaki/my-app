import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { chromium, request as playwrightRequest } from "playwright-core";

const KLMS_BASE_URL = "https://lms.keio.jp";

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

// Opens a real, visible Chrome window so the user can complete login
// (including Okta Verify) themselves. Runs in the background; callers
// should not await this from an HTTP request handler.
export async function connectKlms(userId: number): Promise<void> {
  const browser = await chromium.launch({ channel: "chrome", headless: false });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(KLMS_BASE_URL);
    // Canvas bounces through several redirects after login (including a
    // transient ?login_success=1 URL), so we wait for the dashboard title
    // instead of matching a specific URL.
    await page.waitForFunction(() => document.title.includes("ダッシュボード"), null, {
      timeout: 5 * 60 * 1000,
    });

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
  course_id: number | null;
  plannable: { title?: string; name?: string };
};

// KLMS course names look like "3-12 春[月2 木2]村松 眞由　材料力学 [矢上 12-109]":
// section/semester/schedule, then the professor's name, then a full-width
// space, then the actual course title, then an optional "[building room]".
// We only want the course title itself.
function extractCourseName(rawName: string): string {
  const withoutLocation = rawName.replace(/\s*\[[^\]]*\]\s*$/, "");
  const parts = withoutLocation.split("　");
  return parts[parts.length - 1].trim() || rawName;
}

// The planner/items endpoint defaults to a narrow window around "now" and
// paginates results, so a plain single request silently drops assignments
// that are due far in the past or future. We request a wide explicit date
// range and follow the Link header until there are no more pages.
async function fetchAllPlannerItems(context: Awaited<ReturnType<typeof playwrightRequest.newContext>>) {
  const now = Date.now();
  const startDate = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
  const endDate = new Date(now + 180 * 24 * 60 * 60 * 1000).toISOString();

  const items: PlannerItem[] = [];
  let url: string | null =
    `/api/v1/planner/items?per_page=50&start_date=${startDate}&end_date=${endDate}`;

  while (url) {
    const response = await context.get(url);
    if (!response.ok()) {
      throw new Error(`KLMS API request failed: ${response.status()}`);
    }
    items.push(...((await response.json()) as PlannerItem[]));

    url = null;
    const linkHeader = response.headers()["link"];
    if (linkHeader) {
      const nextLink = linkHeader.split(",").find((part) => part.includes('rel="next"'));
      const match = nextLink?.match(/<([^>]+)>/);
      if (match) {
        url = match[1];
      }
    }
  }
  return items;
}

export async function fetchKlmsAssignments(
  userId: number
): Promise<{ klmsId: string; title: string; dueDate: Date | null; courseName: string | null }[]> {
  const storageState = JSON.parse(decrypt(fs.readFileSync(sessionFilePath(userId), "utf8")));
  const context = await playwrightRequest.newContext({ storageState, baseURL: KLMS_BASE_URL });
  try {
    const items = await fetchAllPlannerItems(context);
    const assignments = items.filter(
      (item) => item.plannable_type === "assignment" || item.plannable_type === "quiz"
    );

    const courseIds = [...new Set(assignments.map((item) => item.course_id).filter((id) => id !== null))];
    const courseNames = new Map<number, string>();
    await Promise.all(
      courseIds.map(async (courseId) => {
        const courseResponse = await context.get(`/api/v1/courses/${courseId}`);
        if (courseResponse.ok()) {
          const course = await courseResponse.json();
          courseNames.set(courseId, extractCourseName(course.name));
        }
      })
    );

    return assignments.map((item) => ({
      klmsId: `${item.plannable_type}-${item.plannable_id}`,
      title: item.plannable.title ?? item.plannable.name ?? "(無題の課題)",
      dueDate: item.plannable_date ? new Date(item.plannable_date) : null,
      courseName: item.course_id !== null ? (courseNames.get(item.course_id) ?? null) : null,
    }));
  } finally {
    await context.dispose();
  }
}
