const raw = process.env.TIB_INPUT ?? "{}";
const input = JSON.parse(raw);
console.log(JSON.stringify(input));