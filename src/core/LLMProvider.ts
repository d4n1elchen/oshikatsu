import { Ollama } from "ollama";
import { z, type ZodType } from "zod";
import { getConfig } from "../config";

export interface LLMProvider {
  extract<T>(text: string, schema: ZodType<T>, systemPrompt: string): Promise<T>;
}

export class OllamaProvider implements LLMProvider {
  private client: Ollama;
  private model: string;

  constructor() {
    const config = getConfig();
    this.client = new Ollama({ host: config.llm.host });
    this.model = config.llm.model;
  }

  async extract<T>(text: string, schema: ZodType<T>, systemPrompt: string): Promise<T> {
    const jsonSchema = zodToJsonSchema(schema);
    
    // We append instructions to the system prompt to enforce JSON
    const fullSystemPrompt = `${systemPrompt}

Return exactly one JSON object. Do not wrap it in markdown or add commentary.
The JSON object must match this schema:
${JSON.stringify(jsonSchema, null, 2)}`;

    try {
      const response = await this.client.chat({
        model: this.model,
        messages: [
          { role: "system", content: fullSystemPrompt },
          { role: "user", content: text }
        ],
        format: jsonSchema,
        options: {
          temperature: 0.1, // Low temp for extraction tasks
        }
      });

      // Parse the JSON string
      const parsedJson = JSON.parse(response.message.content);
      
      // Validate against the Zod schema
      const validatedData = schema.parse(parsedJson);
      return validatedData;
    } catch (error) {
      console.error("[OllamaProvider] Failed to extract data:", error);
      throw error;
    }
  }
}

function zodToJsonSchema(schema: ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema) as Record<string, unknown>;
}
