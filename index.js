import http from "node:http";
const PORT = process.env.PORT || 8888;
const server = http.createServer((req, res) => {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end("再出発、おめでとう！");
});
server.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
