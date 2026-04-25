import { Ollama } from "ollama";
import type { z } from "zod";
import { zodToJsonSchema as z2j } from "zod-to-json-schema";
import { getConfig } from "../config";

export interface LLMProvider {
  extract<T>(text: string, schema: z.ZodSchema<T>, systemPrompt: string): Promise<T>;
}

export class OllamaProvider implements LLMProvider {
  private client: Ollama;
  private model: string;

  constructor() {
    const config = getConfig();
    this.client = new Ollama({ host: config.llm.host });
    this.model = config.llm.model;
  }

  async extract<T>(text: string, schema: z.ZodSchema<T>, systemPrompt: string): Promise<T> {
    const jsonSchema = zodToJsonSchema(schema);
    
    // We append instructions to the system prompt to enforce JSON
    const fullSystemPrompt = `${systemPrompt}\n\nYou MUST return only valid JSON matching this schema:\n${JSON.stringify(jsonSchema, null, 2)}`;

    try {
      const response = await this.client.chat({
        model: this.model,
        messages: [
          { role: "system", content: fullSystemPrompt },
          { role: "user", content: text }
        ],
        format: "json", // Ollama native JSON mode
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

// A simple utility to convert basic Zod schemas to JSON Schema for the LLM prompt.
function zodToJsonSchema(schema: any): any {
  return z2j(schema, { target: "jsonSchema7", $refStrategy: "none" });
}
