/**
 * 模型表与别名解析（源自 2026-10 实测抓包，chat/config/get 响应）
 *
 * 注意：模型是 139 服务端的用户级全局配置（POST /chat/config 切换），
 * 不随对话请求传递。
 */
export const MODELS = [
  { id: "blian_qwen38_max",  name: "qwen3.8-Max",     maxInput: 800000, thinkable: true,  desc: "自主规划能力强，适配复杂任务" },
  { id: "huoshan_glm_5_3",   name: "GLM-5.3",          maxInput: 40000,  thinkable: false, desc: "深度推理能力出众，擅长拆解难题（始终思考）" },
  { id: "blian_qwen38_flash", name: "qwen3.8-Flash",   maxInput: 800000, thinkable: true,  desc: "轻量高效，适配高频次问答场景" },
  { id: "blian_qwen37_plus", name: "qwen3.7-Plus",     maxInput: 800000, thinkable: true,  desc: "全域思考，跨模态统一推理" },
  { id: "blian_qwen36_plus", name: "qwen3.6-Plus",     maxInput: 800000, thinkable: true,  desc: "自主编程，超长上下文理解" },
  { id: "blian_qwen35_plus", name: "qwen3.5-Plus",     maxInput: 800000, thinkable: true,  desc: "原生多模态，超长上下文跨模态理解" },
  { id: "blian_deepseek_v4_pro", name: "DeepSeek-V4-Pro",  maxInput: 40000, thinkable: true, desc: "深度逻辑推理，复杂任务分析" },
  { id: "blian_deepseek_v4_flash", name: "DeepSeek-V4-Flash", maxInput: 40000, thinkable: true, desc: "低延迟推理快，适配日常办公与高频问答" },
  { id: "jiutian", name: "九天大模型", maxInput: 9000, thinkable: false, desc: "中国移动自研，行业增强与安全特性" },
  { id: "vlm_huoshan_2_0_lite_thinking_vision", name: "Seed-2.0-Lite", maxInput: 40000, thinkable: true, desc: "视觉深度思考，跨模态感知" },
];

// 别名归一化：小写 + 去掉非字母数字；剥离上游前缀后 modelType 与显示名可互匹配
const EXTRA_ALIASES = {
  jiutian: "jiutian",
  九天大模型: "jiutian",
  九天: "jiutian",
  seed20lite: "vlm_huoshan_2_0_lite_thinking_vision",
  seed: "vlm_huoshan_2_0_lite_thinking_vision",
  vision: "vlm_huoshan_2_0_lite_thinking_vision",
};

function normalize(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, "");
}

function modelKey(id) {
  return normalize(String(id).replace(/^(blian_|huoshan_|vlm_)/, ""));
}

const LOOKUP = new Map();
for (const m of MODELS) {
  LOOKUP.set(normalize(m.id), m);
  LOOKUP.set(modelKey(m.id), m); // 剥前缀形式，如 qwen38max
  LOOKUP.set(normalize(m.name), m); // 显示名，如 glm53
  for (const [alias, target] of Object.entries(EXTRA_ALIASES)) {
    if (target === m.id) LOOKUP.set(normalize(alias), m);
  }
}

/** 解析调用方传入的模型名 → 模型对象；找不到返回 null */
export function resolveModel(name) {
  if (!name) return null;
  return LOOKUP.get(normalize(name)) || LOOKUP.get(modelKey(name)) || null;
}

/** OpenAI /v1/models 格式 */
export function openaiModels() {
  return {
    object: "list",
    data: MODELS.map((m) => ({
      id: m.id,
      object: "model",
      created: 1728864000,
      owned_by: "139-mail-lingxi",
      // 附加信息（非标准字段，方便客户端展示）
      display_name: m.name,
      max_input_chars: m.maxInput,
      supports_thinking: m.thinkable,
      description: m.desc,
    })),
  };
}
