import { tool } from "@langchain/core/tools";
import type { Skill } from "../../options.js";

const schema = {
  type: "object" as const,
  properties: {
    skillName: {
      type: "string" as const,
      description: "The name of the skill to load (must match a skill from the configured skills list).",
    },
  },
  required: ["skillName"],
};

/**
 * Creates a load_skill tool that returns full skill content for a given skill name.
 * Used for progressive disclosure: descriptions are in the system prompt; full content is loaded on demand.
 */
export function createLoadSkillTool(skills: Skill[]) {
  return tool(
    async ({ skillName }) => {
      const skill = skills.find((s) => s.name === skillName);
      if (skill) {
        const content = typeof skill.content === "function" ? await skill.content() : skill.content;
        return `Loaded skill: ${skillName}\n\n${content}`;
      }
      const available = skills.map((s) => s.name).join(", ");
      return `Skill '${skillName}' not found. Available skills: ${available}`;
    },
    {
      name: "load_skill",
      description: `Load the full content of a skill into context. Use when you need detailed information about a specific area. Available skills: ${skills.map((s) => s.name).join(", ")}.`,
      schema,
    }
  );
}
