import "dotenv/config";
import express from "express";
import session from "express-session";
import bcrypt from "bcrypt";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

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

app.get("/tasks", requireLogin, async (req, res) => {
  const tasks = await prisma.task.findMany({
    where: { userId: req.session.userId },
    orderBy: { createdAt: "desc" },
  });
  res.render("tasks", { tasks });
});

app.post("/tasks", requireLogin, async (req, res) => {
  const title = req.body.title;
  if (title) {
    await prisma.task.create({ data: { title, userId: req.session.userId! } });
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
