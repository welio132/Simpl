const Groq = require('groq-sdk');
const client = new Groq({ apiKey: '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' });

async function tester() {
  const msg = await client.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [{
      role: 'user',
      content: 'Génère des options pour un service de création darches de mariage au Québec. Réponds en JSON avec: prix, options, questions, slogan.'
    }],
    max_tokens: 500
  });
  console.log(msg.choices[0].message.content);
}

tester();