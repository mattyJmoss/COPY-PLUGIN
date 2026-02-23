import { z } from "zod";

const copySttSchema = z
  .object({
    provider: z.literal("whisper-api").optional(),
    url: z.string().optional(),
    model: z.string().optional(),
    language: z.string().optional(),
  })
  .optional();

const copyTtsSchema = z
  .object({
    provider: z.literal("chatterbox").optional(),
    url: z.string().optional(),
    params: z
      .object({
        exaggeration: z.number().optional(),
        cfg_weight: z.number().optional(),
        temperature: z.number().optional(),
      })
      .optional(),
  })
  .optional();

const copyChannelSchema = z
  .object({
    enabled: z.boolean().optional(),
    systemPrompt: z.string().optional(),
  })
  .optional();

const copyDmSchema = z
  .object({
    enabled: z.boolean().optional(),
    policy: z.enum(["pairing", "allowlist", "open", "disabled"]).optional(),
    allowFrom: z.array(z.string()).optional(),
    channels: z.object({}).catchall(copyChannelSchema).optional(),
  })
  .optional();

export const CopyConfigSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  apiUrl: z.string().optional(),
  displayName: z.string().optional(),
  stt: copySttSchema,
  tts: copyTtsSchema,
  dm: copyDmSchema,
  dataDir: z.string().optional(),
  voicePrompt: z.string().optional(),
});
