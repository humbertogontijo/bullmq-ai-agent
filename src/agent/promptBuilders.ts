/**
 * Fluent builders for system prompts and tool descriptions.
 * Follow the structure recommended in docs/PROMPT_GUIDE.md so prompts work
 * consistently with the agent.
 *
 * @example System prompt
 * const prompt = new SystemPromptBuilder()
 *   .role("Support assistant for Acme Corp. Be concise and professional.")
 *   .instructions("Answer only about Acme products.", "Prefer short answers.")
 *   .build();
 *
 * @example Tool description
 * const description = new ToolDescriptionBuilder()
 *   .intro("Hand off the conversation to a human agent.")
 *   .whenToUse("Complaints requiring human handling", "User asks to speak to a human")
 *   .whenNotToUse("For simple approval: use request_human_approval instead.")
 *   .build();
 */

function renderSectionContent(value: string | string[]): string {
  if (Array.isArray(value)) {
    return value.map((line) => (line.trimStart().startsWith("-") ? line : `- ${line}`)).join("\n");
  }
  return value;
}

function ensureBullets(items: string[]): string[] {
  return items.map((item) => (item.trimStart().startsWith("-") ? item : `- ${item}`));
}

// --- SystemPromptBuilder ---

export class SystemPromptBuilder {
  private _role?: string;
  private _instructions?: string | string[];
  private _objective?: string;
  private _constraints?: string | string[];
  private _examples?: string | string[];
  private _sections = new Map<string, string | string[]>();

  /** Role and behavior: who the agent is, tone, domain rules. */
  role(value: string): this {
    this._role = value;
    return this;
  }

  /** What to do, how to respond, constraints. Pass multiple items as separate args or one string. */
  instructions(...value: (string | string[])[]): this {
    const flat = value.flat();
    this._instructions = flat.length === 1 && typeof flat[0] === "string" ? flat[0] : flat;
    return this;
  }

  /** Optional: primary goal (e.g. for summarization). */
  objective(value: string): this {
    this._objective = value;
    return this;
  }

  /** Optional: things the agent must not do or must always do. */
  constraints(...value: (string | string[])[]): this {
    const flat = value.flat();
    this._constraints = flat.length === 1 && typeof flat[0] === "string" ? flat[0] : flat;
    return this;
  }

  /** Optional: example interactions or outputs. */
  examples(...value: (string | string[])[]): this {
    const flat = value.flat();
    this._examples = flat.length === 1 && typeof flat[0] === "string" ? flat[0] : flat;
    return this;
  }

  /** Optional: custom XML-tagged section. Tag name without angle brackets (e.g. "primary_objective"). Content may include placeholders like {name} for build(params). */
  section(tag: string, content: string | string[]): this {
    const safeTag = tag.replace(/[<>/\\]/g, "").trim();
    if (safeTag) this._sections.set(safeTag, content);
    return this;
  }

  /**
   * Produces the system prompt string with XML-style tags.
   * @param params - Optional map of placeholder names to values. Each `{key}` in the prompt is replaced by `params[key]` (missing keys are left as `{key}`).
   */
  build(params?: Record<string, string>): string {
    const parts: string[] = [];

    if (this._role !== undefined && this._role !== "") {
      parts.push(`<role>\n${this._role.trim()}\n</role>`);
    }
    if (this._instructions !== undefined) {
      const content = renderSectionContent(this._instructions);
      if (content) parts.push(`<instructions>\n${content}\n</instructions>`);
    }
    if (this._objective !== undefined && this._objective !== "") {
      parts.push(`<objective>\n${this._objective.trim()}\n</objective>`);
    }
    if (this._constraints !== undefined) {
      const content = renderSectionContent(this._constraints);
      if (content) parts.push(`<constraints>\n${content}\n</constraints>`);
    }
    if (this._examples !== undefined) {
      const content =
        typeof this._examples === "string"
          ? this._examples
          : (this._examples as string[]).join("\n");
      if (content.trim()) parts.push(`<examples>\n${content.trim()}\n</examples>`);
    }

    for (const [tag, value] of this._sections) {
      const content = renderSectionContent(value);
      if (content) parts.push(`<${tag}>\n${content}\n</${tag}>`);
    }

    let out = parts.join("\n\n");
    if (params && Object.keys(params).length > 0) {
      for (const [key, value] of Object.entries(params)) {
        out = out.replace(new RegExp(`\\{${escapeRegExp(key)}\\}`, "g"), value);
      }
    }
    return out;
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// --- ToolDescriptionBuilder ---

export type ToolExample = { scenario: string; reasoning: string };

export class ToolDescriptionBuilder {
  private _intro?: string;
  private _whenToUse: string[] = [];
  private _whenNotToUse: string[] = [];
  private _howToUse: string[] = [];
  private _examples: ToolExample[] = [];
  private _extraSections = new Map<string, string[]>();

  /** One or two sentences: what the tool does. */
  intro(value: string): this {
    this._intro = value;
    return this;
  }

  /** Situations where the tool is appropriate. Pass multiple items as separate args. */
  whenToUse(...items: string[]): this {
    this._whenToUse.push(...items.filter(Boolean));
    return this;
  }

  /** Cases where the tool should not be used (and what to use instead if relevant). */
  whenNotToUse(...items: string[]): this {
    this._whenNotToUse.push(...items.filter(Boolean));
    return this;
  }

  /** Optional: numbered steps or usage rules. */
  howToUse(...steps: string[]): this {
    this._howToUse.push(...steps.filter(Boolean));
    return this;
  }

  /** Optional: add an example with scenario and reasoning. */
  example(scenario: string, reasoning: string): this {
    this._examples.push({ scenario, reasoning });
    return this;
  }

  /** Optional: extra Markdown section (e.g. "Scopes"). Inserted before "When to Use". */
  section(heading: string, lines: string[]): this {
    if (heading && lines.length) this._extraSections.set(heading, lines);
    return this;
  }

  /** Produces the tool description string in the recommended Markdown structure. */
  build(): string {
    const lines: string[] = [];

    if (this._intro) {
      lines.push(this._intro.trim());
    }

    for (const [heading, sectionLines] of this._extraSections) {
      lines.push("");
      lines.push(`## ${heading}`);
      lines.push(...ensureBullets(sectionLines));
    }

    if (this._whenToUse.length > 0) {
      lines.push("");
      lines.push("## When to Use This Tool");
      lines.push(...ensureBullets(this._whenToUse));
    }

    if (this._whenNotToUse.length > 0) {
      lines.push("");
      lines.push("## When NOT to Use This Tool");
      lines.push(...ensureBullets(this._whenNotToUse));
    }

    if (this._howToUse.length > 0) {
      lines.push("");
      lines.push("## How to Use This Tool");
      this._howToUse.forEach((step, i) => {
        const pref = step.trimStart().match(/^\d+[.)]\s*/) ? step : `${i + 1}. ${step}`;
        lines.push(pref);
      });
    }

    if (this._examples.length > 0) {
      lines.push("");
      lines.push("## Examples");
      for (const ex of this._examples) {
        lines.push("");
        lines.push("<example>");
        lines.push(ex.scenario.trim());
        lines.push("</example>");
        lines.push("");
        lines.push("<reasoning>");
        lines.push(ex.reasoning.trim());
        lines.push("</reasoning>");
      }
    }

    return lines.join("\n");
  }
}
