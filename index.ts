import "dotenv/config";
import express from "express";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const app = express();
const PORT = process.env.PORT || 8888;

app.set("view engine", "ejs");
app.set("views", "./views");
app.use(express.urlencoded({ extended: true }));

app.get("/", async (req, res) => {
  // prisma の中身をログに出して、何が定義されているか見るぞ
  console.log("利用可能なモデル:", Object.keys(prisma));
  
  if (!prisma.user) {
    res.status(500).send("エラー：prisma.user が見つかりませぬ。generate が失敗しておるかもしれません。");
    return;
  }

  const users = await prisma.user.findMany();
  res.render("index", { users });
});


app.post("/users", async (req, res) => {
  const name = req.body.name;
  if (name) {
    await prisma.user.create({ data: { name } });
  }
  res.redirect("/");
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
