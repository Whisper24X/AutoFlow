const express = require("express");
const path = require("path");

const app = express();
const port = process.env.PORT || 4173;

app.use(express.static(path.join(__dirname, "../public")));

app.listen(port, () => {
  console.log(`Demo app is running at http://localhost:${port}`);
});
