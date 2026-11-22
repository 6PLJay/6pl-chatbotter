const fs = require("fs");
const path = require("path");

const folder = path.join(__dirname, "messages");

function loadCategory(category) {
  const file = path.join(folder, `${category}.json`);

  if (!fs.existsSync(file)) {
    throw new Error(`Missing message category: ${category}`);
  }

  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function getRandomMessage(category) {
  const messages = loadCategory(category);

  if (!messages.length) {
    return null;
  }

  return messages[
    Math.floor(Math.random() * messages.length)
  ];
}

function getAllCategories() {
  return fs.readdirSync(folder)
    .filter(file => file.endsWith(".json"))
    .map(file => file.replace(".json", ""));
}

module.exports = {
  loadCategory,
  getRandomMessage,
  getAllCategories
};