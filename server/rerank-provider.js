const groqRerankProvider = require("./providers/groq-rerank");

async function rerankProducts(input) {
  const provider = (process.env.RERANK_PROVIDER || "groq").toLowerCase();
  if (provider === "groq") return groqRerankProvider.rerank(input);
  throw new Error(`Unsupported RERANK_PROVIDER: ${provider}`);
}

module.exports = { rerankProducts };
