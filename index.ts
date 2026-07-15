import "dotenv/config";
import express from "express";
import session from "express-session";
import bcrypt from "bcrypt";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, RecurrenceType } from "@prisma/client";
import { connectKlms, fetchKlmsAssignments, hasKlmsSession } from "./klms.ts";

declare module "express-session" {
  interface SessionData {
    userId: number;
  }
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const app = express();
const PORT = process.env.PORT || 8888;

app.set("view engine", "ejs");
app.set("views", "./views");
app.use(express.static("public"));
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || "dev-secret",
    resave: false,
    saveUninitialized: false,
  })
);

function requireLogin(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!req.session.userId) {
    res.redirect("/login");
    return;
  }
  next();
}

function sortCategoriesByHierarchy<T extends { id: number; parentId: number | null }>(
  categories: T[]
): (T & { depth: number })[] {
  const byParent = new Map<number | null, T[]>();
  for (const category of categories) {
    const siblings = byParent.get(category.parentId) ?? [];
    siblings.push(category);
    byParent.set(category.parentId, siblings);
  }

  const result: (T & { depth: number })[] = [];
  function walk(parentId: number | null, depth: number) {
    for (const category of byParent.get(parentId) ?? []) {
      result.push({ ...category, depth });
      walk(category.id, depth + 1);
    }
  }
  walk(null, 0);
  return result;
}

type CategoryNode = { id: number; name: string; children: CategoryNode[] };

function buildCategoryTree(categories: { id: number; name: string; parentId: number | null }[]): CategoryNode[] {
  const byParent = new Map<number | null, typeof categories>();
  for (const category of categories) {
    const siblings = byParent.get(category.parentId) ?? [];
    siblings.push(category);
    byParent.set(category.parentId, siblings);
  }

  function build(parentId: number | null): CategoryNode[] {
    return (byParent.get(parentId) ?? []).map((category) => ({
      id: category.id,
      name: category.name,
      children: build(category.id),
    }));
  }
  return build(null);
}

function getSelfAndDescendantIds(categoryId: number, categories: { id: number; parentId: number | null }[]): Set<number> {
  const byParent = new Map<number | null, number[]>();
  for (const category of categories) {
    const siblings = byParent.get(category.parentId) ?? [];
    siblings.push(category.id);
    byParent.set(category.parentId, siblings);
  }

  const ids = new Set<number>([categoryId]);
  function walk(id: number) {
    for (const childId of byParent.get(id) ?? []) {
      ids.add(childId);
      walk(childId);
    }
  }
  walk(categoryId);
  return ids;
}

function buildCategoryColors(categories: { id: number; parentId: number | null }[]): Record<number, string> {
  const byId = new Map(categories.map((category) => [category.id, category]));

  function getRootId(id: number): number {
    let current = byId.get(id)!;
    while (current.parentId !== null) {
      current = byId.get(current.parentId)!;
    }
    return current.id;
  }

  const rootIds = [...new Set(categories.map((category) => getRootId(category.id)))].sort((a, b) => a - b);
  const rootIndex = new Map(rootIds.map((id, index) => [id, index]));

  const colors: Record<number, string> = {};
  for (const category of categories) {
    const index = rootIndex.get(getRootId(category.id))!;
    const hue = (index * 137.508) % 360;
    colors[category.id] = `hsl(${hue}, 70%, 45%)`;
  }
  return colors;
}

function parseRecurrence(body: express.Request["body"]) {
  const recurrenceType: RecurrenceType = Object.values(RecurrenceType).includes(body.recurrenceType)
    ? body.recurrenceType
    : RecurrenceType.NONE;

  const daysOfWeek = ([] as string[]).concat(body.recurrenceDaysOfWeek ?? []);

  return {
    recurrenceType,
    recurrenceDaysOfWeek: recurrenceType === RecurrenceType.WEEKLY ? daysOfWeek.map(Number) : [],
    recurrenceDayOfMonth:
      recurrenceType === RecurrenceType.MONTHLY && body.recurrenceDayOfMonth
        ? Number(body.recurrenceDayOfMonth)
        : null,
  };
}

function parseCategoryIds(body: express.Request["body"]) {
  return ([] as string[]).concat(body.categoryIds ?? []).map(Number);
}

const klmsStatus = new Map<number, "connecting" | "connected" | "error" | "unavailable">();

const OVERDUE_CATEGORY_NAME = "期限切れ";

// Keeps the "期限切れ" tag in sync with each task's actual due date: attach it
// to undone tasks whose due date has passed, and remove it from tasks that no
// longer qualify (completed, due date cleared, or pushed into the future).
async function syncOverdueCategory(userId: number): Promise<void> {
  const now = new Date();

  const overdueTasks = await prisma.task.findMany({
    where: { userId, done: false, dueDate: { lt: now }, categories: { none: { name: OVERDUE_CATEGORY_NAME } } },
    select: { id: true },
  });
  const staleTaggedTasks = await prisma.task.findMany({
    where: {
      userId,
      categories: { some: { name: OVERDUE_CATEGORY_NAME, parentId: null } },
      OR: [{ done: true }, { dueDate: null }, { dueDate: { gte: now } }],
    },
    select: { id: true },
  });

  if (overdueTasks.length === 0 && staleTaggedTasks.length === 0) {
    return;
  }

  let overdueCategory = await prisma.category.findFirst({
    where: { userId, parentId: null, name: OVERDUE_CATEGORY_NAME },
  });
  if (!overdueCategory && overdueTasks.length > 0) {
    overdueCategory = await prisma.category.create({
      data: { userId, parentId: null, name: OVERDUE_CATEGORY_NAME },
    });
  }

  if (overdueCategory) {
    for (const task of overdueTasks) {
      await prisma.task.update({
        where: { id: task.id },
        data: { categories: { connect: { id: overdueCategory.id } } },
      });
    }
    for (const task of staleTaggedTasks) {
      await prisma.task.update({
        where: { id: task.id },
        data: { categories: { disconnect: { id: overdueCategory.id } } },
      });
    }
  }
}

app.get("/", (req, res) => {
  res.redirect(req.session.userId ? "/tasks" : "/login");
});

app.get("/signup", (req, res) => {
  res.render("signup", { error: null });
});

app.post("/signup", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    res.render("signup", { error: "全ての項目を入力してください" });
    return;
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    res.render("signup", { error: "このメールアドレスは既に登録されています" });
    return;
  }

  const hashed = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({ data: { name, email, password: hashed } });
  req.session.userId = user.id;
  res.redirect("/tasks");
});

app.get("/login", (req, res) => {
  res.render("login", { error: null });
});

app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !(await bcrypt.compare(password, user.password))) {
    res.render("login", { error: "メールアドレスまたはパスワードが違います" });
    return;
  }
  req.session.userId = user.id;
  res.redirect("/tasks");
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login");
  });
});

app.post("/account/delete", requireLogin, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.session.userId } });
  if (!user || !(await bcrypt.compare(req.body.password, user.password))) {
    const categories = await prisma.category.findMany({
      where: { userId: req.session.userId },
      orderBy: { name: "asc" },
    });
    res.render("settings", {
      error: "パスワードが違います",
      klmsConnected: hasKlmsSession(req.session.userId!),
      klmsStatus: klmsStatus.get(req.session.userId!) ?? null,
      categories: sortCategoriesByHierarchy(categories),
    });
    return;
  }

  await prisma.user.delete({ where: { id: user.id } });
  req.session.destroy(() => {
    res.redirect("/login");
  });
});

app.get("/tasks", requireLogin, async (req, res) => {
  await syncOverdueCategory(req.session.userId!);

  const [tasks, categories] = await Promise.all([
    prisma.task.findMany({
      where: { userId: req.session.userId },
      orderBy: { createdAt: "desc" },
      include: { categories: true },
    }),
    prisma.category.findMany({ where: { userId: req.session.userId }, orderBy: { name: "asc" } }),
  ]);

  const homeCategories = categories.filter((c) => c.showOnHome);
  const categoryColors = buildCategoryColors(categories);
  const panels = [
    { id: null, name: "すべて", color: null, tasks },
    ...homeCategories.map((category) => {
      const includedIds = getSelfAndDescendantIds(category.id, categories);
      return {
        id: category.id,
        name: category.name,
        color: categoryColors[category.id],
        tasks: tasks.filter((task) => task.categories.some((c) => includedIds.has(c.id))),
      };
    }),
  ];

  res.render("tasks", {
    panels,
    categories: sortCategoriesByHierarchy(categories),
    categoryTree: buildCategoryTree(categories),
    categoryColors,
  });
});

app.get("/settings", requireLogin, async (req, res) => {
  const categories = await prisma.category.findMany({
    where: { userId: req.session.userId },
    orderBy: { name: "asc" },
  });
  res.render("settings", {
    error: null,
    klmsConnected: hasKlmsSession(req.session.userId!),
    klmsStatus: klmsStatus.get(req.session.userId!) ?? null,
    categories: sortCategoriesByHierarchy(categories),
  });
});

app.post("/settings/home-categories", requireLogin, async (req, res) => {
  const selectedIds = new Set(parseCategoryIds(req.body));
  const categories = await prisma.category.findMany({
    where: { userId: req.session.userId },
    select: { id: true },
  });
  await Promise.all(
    categories.map((category) =>
      prisma.category.update({
        where: { id: category.id },
        data: { showOnHome: selectedIds.has(category.id) },
      })
    )
  );
  res.redirect("/settings");
});

app.post("/integrations/klms/connect", requireLogin, (req, res) => {
  const userId = req.session.userId!;
  klmsStatus.set(userId, "connecting");
  connectKlms(userId)
    .then(async () => {
      await prisma.user.update({ where: { id: userId }, data: { klmsConnectedAt: new Date() } });
      klmsStatus.set(userId, "connected");
    })
    .catch((error) => {
      console.error("KLMS連携に失敗しました:", error);
      // No visible browser is available in this environment (e.g. a
      // headless server like Render) - Playwright can't launch Chrome there.
      const message = String(error?.message ?? error);
      const isUnsupportedEnvironment =
        message.includes("Executable doesn't exist") || message.includes("Missing X server");
      klmsStatus.set(userId, isUnsupportedEnvironment ? "unavailable" : "error");
    });
  res.redirect("/settings");
});

app.post("/integrations/klms/sync", requireLogin, async (req, res) => {
  const userId = req.session.userId!;
  if (!hasKlmsSession(userId)) {
    res.redirect("/settings");
    return;
  }

  const assignments = await fetchKlmsAssignments(userId);

  let schoolCategory = await prisma.category.findFirst({ where: { userId, parentId: null, name: "学校" } });
  if (!schoolCategory) {
    schoolCategory = await prisma.category.create({ data: { userId, parentId: null, name: "学校" } });
  }

  const courseCategoryIds = new Map<string, number>();
  async function getCourseCategoryId(courseName: string): Promise<number> {
    const cached = courseCategoryIds.get(courseName);
    if (cached) return cached;

    let category = await prisma.category.findFirst({
      where: { userId, parentId: schoolCategory!.id, name: courseName },
    });
    if (!category) {
      category = await prisma.category.create({
        data: { userId, parentId: schoolCategory!.id, name: courseName },
      });
    }
    courseCategoryIds.set(courseName, category.id);
    return category.id;
  }

  // Category lookups/creations must happen sequentially to avoid racing
  // duplicate-category creation, but once every course category exists the
  // task upserts are independent and can run in parallel.
  const courseNames = [...new Set(assignments.map((a) => a.courseName).filter((name) => name !== null))];
  for (const courseName of courseNames) {
    await getCourseCategoryId(courseName);
  }

  await Promise.all(
    assignments.map((assignment) => {
      const categoryIds = assignment.courseName ? [courseCategoryIds.get(assignment.courseName)!] : [];
      return prisma.task.upsert({
        where: { userId_klmsId: { userId, klmsId: assignment.klmsId } },
        update: {
          title: assignment.title,
          dueDate: assignment.dueDate,
          categories: { connect: categoryIds.map((id) => ({ id })) },
        },
        create: {
          title: assignment.title,
          dueDate: assignment.dueDate,
          userId,
          klmsId: assignment.klmsId,
          categories: { connect: categoryIds.map((id) => ({ id })) },
        },
      });
    })
  );
  res.redirect("/settings");
});

app.post("/integrations/klms/tasks/delete-all", requireLogin, async (req, res) => {
  await prisma.task.deleteMany({ where: { userId: req.session.userId, klmsId: { not: null } } });
  res.redirect("/settings");
});

app.post("/tasks", requireLogin, async (req, res) => {
  const { title, dueDate } = req.body;
  if (title) {
    await prisma.task.create({
      data: {
        title,
        userId: req.session.userId!,
        dueDate: dueDate ? new Date(dueDate) : null,
        categories: { connect: parseCategoryIds(req.body).map((id) => ({ id })) },
        ...parseRecurrence(req.body),
      },
    });
  }
  res.redirect("/tasks");
});

app.post("/categories", requireLogin, async (req, res) => {
  const { name, parentId } = req.body;
  if (name) {
    await prisma.category.create({
      data: {
        name,
        userId: req.session.userId!,
        parentId: parentId ? Number(parentId) : null,
      },
    });
  }
  res.redirect("/tasks");
});

app.post("/tasks/:id/edit", requireLogin, async (req, res) => {
  const id = Number(req.params.id);
  const { title, dueDate } = req.body;
  const task = await prisma.task.findFirst({ where: { id, userId: req.session.userId } });
  if (task) {
    await prisma.task.update({
      where: { id },
      data: {
        title,
        dueDate: dueDate ? new Date(dueDate) : null,
        categories: { set: parseCategoryIds(req.body).map((categoryId) => ({ id: categoryId })) },
        ...parseRecurrence(req.body),
      },
    });
  }
  res.redirect("/tasks");
});

app.post("/tasks/:id/toggle", requireLogin, async (req, res) => {
  const id = Number(req.params.id);
  const task = await prisma.task.findFirst({ where: { id, userId: req.session.userId } });
  if (task) {
    await prisma.task.update({ where: { id }, data: { done: !task.done } });
  }
  res.redirect("/tasks");
});

app.post("/tasks/:id/delete", requireLogin, async (req, res) => {
  const id = Number(req.params.id);
  await prisma.task.deleteMany({ where: { id, userId: req.session.userId } });
  res.redirect("/tasks");
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
