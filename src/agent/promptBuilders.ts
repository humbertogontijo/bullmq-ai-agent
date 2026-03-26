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
 * @example Section with intro + bullets
 * new SystemPromptBuilder()
 *   .section("todo_list", {
 *     intro: "Something about the section...",
 *     bullets: ["point 1", "point 2"],
 *   })
 *   .build();
 *
 * @example Tool description
 * const description = new ToolDescriptionBuilder()
 *   .intro("Hand off the conversation to a human agent.")
 *   .whenToUse("Complaints requiring human handling", "User asks to speak to a human")
 *   .whenNotToUse("For simple approval: use request_human_approval instead.")
 *   .build();
 */

/** Object form: plain paragraph(s) plus an optional bullet list. */
export type SectionContentObject = {
  /** Plain text before the list; use `string[]` for multiple paragraphs (joined with blank lines). */
  intro?: string | string[];
  bullets?: string[];
};

/**
 * Content for `.section()`, `.instructions()`, `.constraints()`, and tool `.section()`.
 * - `string`: used as-is (trimmed).
 * - `string[]`: each item is one bullet (optional leading `-` is normalized).
 * - `{ intro?, bullets? }`: intro paragraph(s) without bullets, then a bullet list.
 */
export type SectionContent = string | string[] | SectionContentObject;

/**
 * Normalizes one line to a single Markdown list bullet. Strips an optional
 * leading `-` so array items may omit or include `-` without inconsistent output.
 */
function normalizeBulletLine(line: string): string {
  const t = line.trim();
  if (t === "") return "";
  return `- ${t.replace(/^\-\s*/, "")}`;
}

function isSectionContentObject(x: unknown): x is SectionContentObject {
  return (
    typeof x === "object" &&
    x !== null &&
    !Array.isArray(x) &&
    ("intro" in x || "bullets" in x)
  );
}

/** Renders {@link SectionContent} to a single Markdown string. */
export function renderSectionContent(value: SectionContent): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value.map(normalizeBulletLine).filter(Boolean).join("\n");
  }
  const parts: string[] = [];
  if (value.intro !== undefined) {
    const introText = Array.isArray(value.intro)
      ? value.intro.map((s) => s.trim()).filter(Boolean).join("\n\n")
      : value.intro.trim();
    if (introText) parts.push(introText);
  }
  if (value.bullets?.length) {
    const bl = value.bullets.map(normalizeBulletLine).filter(Boolean).join("\n");
    if (bl) parts.push(bl);
  }
  return parts.join("\n\n");
}

function ensureBullets(items: string[]): string[] {
  return items.map(normalizeBulletLine).filter(Boolean);
}

// --- SystemPromptBuilder ---

export class SystemPromptBuilder {
  private _role?: string;
  private _instructions?: SectionContent;
  private _objective?: string;
  private _constraints?: SectionContent;
  private _examples?: string | string[];
  private _sections = new Map<string, SectionContent>();

  /** Role and behavior: who the agent is, tone, domain rules. */
  role(value: string): this {
    this._role = value;
    return this;
  }

  /**
   * What to do, how to respond, constraints. Pass multiple strings for an all-bullet block,
   * one string for prose, or `{ intro, bullets }` for a paragraph plus bullets (pass that object alone — do not mix with other arguments).
   */
  instructions(...value: (string | string[] | SectionContentObject)[]): this {
    this._instructions = normalizeInstructionLikeArgs(value);
    return this;
  }

  /** Optional: primary goal (e.g. for summarization). */
  objective(value: string): this {
    this._objective = value;
    return this;
  }

  /**
   * Optional: things the agent must not do or must always do.
   * Same shapes as {@link instructions} (including `{ intro, bullets }` as the only argument when used).
   */
  constraints(...value: (string | string[] | SectionContentObject)[]): this {
    this._constraints = normalizeInstructionLikeArgs(value);
    return this;
  }

  /** Optional: example interactions or outputs (joined with newlines when an array; no auto-bullets). */
  examples(...value: (string | string[])[]): this {
    const flat = value.flat();
    this._examples = flat.length === 1 && typeof flat[0] === "string" ? flat[0] : flat;
    return this;
  }

  /**
   * Optional: custom XML-tagged section. Tag name without angle brackets (e.g. "primary_objective").
   * Content may include placeholders like {name} for build(params).
   * Use a string, a string array (all bullets), or `{ intro, bullets }` for prose plus a list.
   */
  section(tag: string, content: SectionContent): this {
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

function normalizeInstructionLikeArgs(
  value: (string | string[] | SectionContentObject)[],
): SectionContent | undefined {
  const flat = value.flat();
  if (flat.length === 0) return undefined;
  if (flat.length === 1 && isSectionContentObject(flat[0])) {
    return flat[0];
  }
  if (flat.length === 1 && typeof flat[0] === "string") {
    return flat[0];
  }
  const stringsOnly = flat.filter((x): x is string => typeof x === "string");
  return stringsOnly;
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
  private _extraSections = new Map<string, SectionContent>();

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

  /**
   * Optional: extra Markdown section (e.g. "Scopes"). Inserted before "When to Use".
   * Same {@link SectionContent} shapes as {@link SystemPromptBuilder.section}.
   */
  section(heading: string, content: SectionContent): this {
    if (!heading.trim()) return this;
    const rendered = renderSectionContent(content).trim();
    if (!rendered) return this;
    this._extraSections.set(heading, content);
    return this;
  }

  /** Produces the tool description string in the recommended Markdown structure. */
  build(): string {
    const lines: string[] = [];

    if (this._intro) {
      lines.push(this._intro.trim());
    }

    for (const [heading, sectionValue] of this._extraSections) {
      lines.push("");
      lines.push(`## ${heading}`);
      lines.push(renderSectionContent(sectionValue));
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
