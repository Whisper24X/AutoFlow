const express = require("express");
const path = require("path");

const app = express();
const port = process.env.PORT || 4174;

app.use(express.static(path.join(__dirname, "../public")));

app.listen(port, () => {
  console.log(`Mini Mario demo: http://127.0.0.1:${port}`);
});
