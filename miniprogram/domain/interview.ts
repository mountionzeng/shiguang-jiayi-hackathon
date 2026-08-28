/**
 * 回忆采访的提问策略。
 *
 * 规则来源：共享人生之书需求 R5、R6、R7、R17。
 * - 全家看到同一个共享问题，但每个人的采访过程彼此独立。
 * - 只有一个采访入口，不让用户先判断"随手记"还是"回忆录"。
 * - 每轮只追问一个方向，并且不连续追问同一个方向。
 * - 这是本地规则引擎，不是模型输出；界面必须如实标注，不得冒充 AI。
 */

export type InterviewDimension = "person" | "time" | "place" | "event" | "feeling";
export type InterviewMode = "personal" | "family";

export const INTERVIEW_DIMENSIONS: InterviewDimension[] = [
  "person",
  "time",
  "place",
  "event",
  "feeling",
];

/** 追问卡片上的标签，沿用队友原型「追问人物 / 追问地点」的写法。 */
export const DIMENSION_LABELS: Record<InterviewDimension, string> = {
  person: "追问人物",
  time: "追问时候",
  place: "追问地点",
  event: "追问经过",
  feeling: "追问感受",
};

/** 保存页上「已经说到」的短标签。 */
export const DIMENSION_CHIPS: Record<InterviewDimension, string> = {
  person: "人物",
  time: "时间",
  place: "地点",
  event: "经过",
  feeling: "感受",
};

export interface SharedQuestion {
  id: string;
  text: string;
  hint: string;
}

/** 人生之书的问题只问“我”，不把用户带去替别人作传。 */
export const PERSONAL_QUESTIONS: SharedQuestion[] = [
  {
    id: "self-first-home",
    text: "你最早记得的那个家，是什么样子？",
    hint: "从一扇门、一张桌子或一种声音说起就好。",
  },
  {
    id: "self-proud",
    text: "你第一次觉得“这件事我做到了”，是在什么时候？",
    hint: "不用是大事，一次考试、一份工作或一道菜都可以。",
  },
  {
    id: "self-road",
    text: "你年轻时每天最常走的是哪一条路？",
    hint: "说说从哪里出发、路上会经过什么。",
  },
  {
    id: "self-keepsake",
    text: "你有没有一件一直舍不得丢的东西？",
    hint: "它从哪里来，又陪你经历过什么？",
  },
  {
    id: "self-turning",
    text: "哪一天之后，你觉得自己和以前不一样了？",
    hint: "记不清日期没关系，先讲那天发生了什么。",
  },
];

/** 共享问题池：同一天全家看到同一个问题，形成"一起写一本书"的实感。 */
export const SHARED_QUESTIONS: SharedQuestion[] = [
  {
    id: "q-hands",
    text: "家里谁有一双让你一看就记得的手？那双手最常做什么？",
    hint: "从一个动作说起，也说说你当时在旁边做什么。",
  },
  {
    id: "q-door",
    text: "你和家人共同住过最久的屋子，门口是什么样子？",
    hint: "颜色、声音、台阶高低，任何一个共同记得的细节都算。",
  },
  {
    id: "q-meal",
    text: "家里哪一道菜，一吃就让你想起某位家人？",
    hint: "是谁做的、你们什么时候一起吃，想到哪儿说到哪儿。",
  },
  {
    id: "q-song",
    text: "家里有没有一首大家都会哼的调子，或一句常挂在嘴边的话？",
    hint: "哼不全没关系，记得几个字就写几个字。",
  },
  {
    id: "q-walk",
    text: "你和家人一起走过最多次的那条路，是什么样的？",
    hint: "上学、赶集、探亲，哪一条都可以。",
  },
  {
    id: "q-weather",
    text: "你记得和家人一起经历过的某个下雨天吗？",
    hint: "谁在场、你们在做什么，天气会把画面带回来。",
  },
  {
    id: "q-keepsake",
    text: "家里有没有一件大家一直舍不得扔的东西？",
    hint: "说说它长什么样，和家里的谁有关。",
  },
];

const FOLLOW_UP_TEMPLATES: Record<InterviewDimension, string[]> = {
  person: [
    "那时候他身边还有谁？",
    "这件事里还有别人在场吗，是谁？",
    "这件事，家里还有谁也知道？",
  ],
  time: [
    "大概是哪一年，或者他多大的时候？",
    "那是什么季节，天冷还是热？",
    "这件事是发生过一次，还是常常发生？",
  ],
  place: [
    "这件事发生在哪儿？屋里还是外头？",
    "那个地方长什么样，你还记得吗？",
    "从家里走到那儿，要走多久？",
  ],
  event: [
    "后来呢，接着发生了什么？",
    "那天他具体做了什么？",
    "这件事是怎么结束的？",
  ],
  feeling: [
    "当时他心里是什么感觉，你看得出来吗？",
    "现在回头想这件事，你自己是什么感觉？",
    "这件事让你想起他的什么？",
  ],
};

const PERSONAL_FOLLOW_UP_TEMPLATES: Record<InterviewDimension, string[]> = {
  person: [
    "那时候谁和你在一起？",
    "这件事里，还有谁对你很重要？",
    "你最想把这段讲给谁听？",
  ],
  time: [
    "大概是哪一年，或者你多大的时候？",
    "那是什么季节，天冷还是热？",
    "这是只发生过一次，还是常常发生？",
  ],
  place: [
    "这件事发生在哪儿？屋里还是外头？",
    "那个地方长什么样，你还记得吗？",
    "从你当时住的地方到那儿，要走多久？",
  ],
  event: [
    "后来呢，接着发生了什么？",
    "那天你具体做了什么？",
    "这件事最后是怎么结束的？",
  ],
  feeling: [
    "当时你心里是什么感觉？",
    "现在回头想这件事，你是什么感觉？",
    "这件事给你留下了什么？",
  ],
};

const DIMENSION_KEYWORDS: Record<InterviewDimension, RegExp> = {
  person: /爸|妈|父|母|爷|奶|外公|外婆|哥|姐|弟|妹|叔|姑|舅|婶|嫂|邻居|同事|同学|朋友|师傅|孩子|他|她/,
  time: /年|月|日|岁|那时|后来|小时候|以前|从前|当时|冬|夏|春|秋|早上|晚上|中午|点钟|年代|解放|文革|改革/,
  place: /家|村|镇|城|巷|院|屋|房|厂|学校|医院|路|街|山|河|田|门口|老家|北京|上海|车站/,
  event: /做|去|买|走|干|修|带|送|结婚|上班|下乡|参军|搬|生|考|开|种|盖|挑|背|织/,
  feeling: /高兴|难过|想念|怕|喜欢|舍不得|心里|感觉|开心|委屈|踏实|着急|温柔|安心|遗憾|骄傲/,
};

/** 这段回答里已经自然带出了哪些方向，用来避免重复追问同一件事。 */
export function detectCoveredDimensions(answer: string): InterviewDimension[] {
  return INTERVIEW_DIMENSIONS.filter((dimension) =>
    DIMENSION_KEYWORDS[dimension].test(answer),
  );
}

export interface InterviewPrompt {
  dimension: InterviewDimension;
  text: string;
}

export interface NextPromptInput {
  answer: string;
  /** 之前已经追问过的方向，按提问顺序排列。 */
  askedDimensions: InterviewDimension[];
  mode?: InterviewMode;
}

/**
 * 选出下一个追问方向：优先问回答里还没提到、且问得最少的方向，
 * 并且永远不会和上一轮是同一个方向。
 */
export function nextInterviewPrompt(input: NextPromptInput): InterviewPrompt {
  const { answer, askedDimensions } = input;
  const lastDimension = askedDimensions[askedDimensions.length - 1];
  const covered = detectCoveredDimensions(answer);

  const askedCount = new Map<InterviewDimension, number>();
  INTERVIEW_DIMENSIONS.forEach((dimension) => askedCount.set(dimension, 0));
  askedDimensions.forEach((dimension) => {
    askedCount.set(dimension, (askedCount.get(dimension) ?? 0) + 1);
  });

  const candidates = INTERVIEW_DIMENSIONS.filter(
    (dimension) => dimension !== lastDimension,
  );
  const uncovered = candidates.filter((dimension) => !covered.includes(dimension));
  const pool = uncovered.length > 0 ? uncovered : candidates;

  const dimension = pool.reduce((best, current) =>
    (askedCount.get(current) ?? 0) < (askedCount.get(best) ?? 0) ? current : best,
  );

  const templates =
    input.mode === "personal"
      ? PERSONAL_FOLLOW_UP_TEMPLATES[dimension]
      : FOLLOW_UP_TEMPLATES[dimension];
  const text = templates[(askedCount.get(dimension) ?? 0) % templates.length];

  return { dimension, text };
}

function stableHash(seed: string): number {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) % 100000007;
  }
  return hash;
}

/** 同一个 seed（例如同一天）下，全家拿到同一个共享问题。 */
export function pickSharedQuestion(seed: string): SharedQuestion {
  return SHARED_QUESTIONS[stableHash(seed) % SHARED_QUESTIONS.length];
}

export function pickInterviewQuestion(
  seed: string,
  mode: InterviewMode,
): SharedQuestion {
  const pool = mode === "personal" ? PERSONAL_QUESTIONS : SHARED_QUESTIONS;
  return pool[stableHash(seed) % pool.length];
}

/** 把日期转成"全家同一天同一个问题"的 seed。 */
export function sharedQuestionSeed(now = new Date()): string {
  const year = now.getFullYear();
  const month = `${now.getMonth() + 1}`.padStart(2, "0");
  const day = `${now.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}


/**
 * 从讲述人自己的话里截一个标题出来。
 *
 * 只做截取，不改写、不概括、不补词：本地演示阶段没有模型，
 * 任何"归纳"都会变成替讲述人编话。标题在保存页上可以直接改。
 */
export function draftTitleFromAnswers(answers: string[]): string {
  const first = (answers[0] ?? "").trim();
  if (!first) return "";

  const clause = first.split(/[，。！？；：、\s]/).filter(Boolean)[0] ?? first;
  return clause.length > 14 ? `${clause.slice(0, 14)}…` : clause;
}
