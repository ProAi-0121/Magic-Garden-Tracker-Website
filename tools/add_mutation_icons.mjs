// one-off: attach verified wiki icon urls to mutation_data.json
import fs from "node:fs";
const m = JSON.parse(fs.readFileSync("mutation_data.json", "utf8"));
const files = {
  Wet: "Wet",
  Chilled: "Chilled",
  Frozen: "Frozen",
  Thunderstruck: "Thunderstruck",
  Thundercharged: "Thundercharged",
  Dawnlit: "Dawnlit",
  Ambershine: "Amberlit",
  Dawncharged: "Dawnbound",
  Ambercharged: "Amberbound",
};
for (const x of m.elemental) {
  const f = files[x.gameId];
  if (f) x.image = `https://media.magicgarden.wiki/${f}.png`;
}
fs.writeFileSync("mutation_data.json", JSON.stringify(m, null, 2));
console.log(m.elemental.map((x) => `${x.gameId} -> ${x.image ? x.image.split("/").pop() : "none"}`).join("\n"));
