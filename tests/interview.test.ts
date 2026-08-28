import assert from "node:assert/strict";
import test from "node:test";

import {
  detectCoveredDimensions,
  draftTitleFromAnswers,
  INTERVIEW_DIMENSIONS,
  InterviewDimension,
  nextInterviewPrompt,
  PERSONAL_QUESTIONS,
  pickInterviewQuestion,
  pickSharedQuestion,
  sharedQuestionSeed,
} from "../miniprogram/domain/interview";

test("the interviewer never asks the same direction twice in a row", () => {
  let asked: InterviewDimension[] = [];
  const answers = [
    "他那时候在纺织厂上班。",
    "大概是六几年吧，我记不太清了。",
    "就在城南那个院子里。",
    "他每天早上四点就起来了。",
    "我心里到现在还挺想他的。",
    "那时候我妈也在。",
  ];

  for (const answer of answers) {
    const prompt = nextInterviewPrompt({ answer, askedDimensions: asked });
    assert.notEqual(
      prompt.dimension,
      asked[asked.length - 1],
      "连续两轮追问了同一个方向",
    );
    assert.ok(prompt.text.length > 0);
    asked = asked.concat([prompt.dimension]);
  }
});

test("a direction already covered by the answer is not the first thing asked back", () => {
  const prompt = nextInterviewPrompt({
    answer: "一九六二年的秋天，他在城南的院子里修收音机。",
    askedDimensions: [],
  });

  assert.ok(!["time", "place", "event"].includes(prompt.dimension));
});

test("every direction eventually gets asked rather than looping over two", () => {
  let asked: InterviewDimension[] = [];
  for (let round = 0; round < INTERVIEW_DIMENSIONS.length; round += 1) {
    const prompt = nextInterviewPrompt({ answer: "嗯。", askedDimensions: asked });
    asked = asked.concat([prompt.dimension]);
  }

  assert.equal(new Set(asked).size, INTERVIEW_DIMENSIONS.length);
});

test("keyword detection recognises the directions an answer already covers", () => {
  assert.deepEqual(detectCoveredDimensions("那年冬天我妈带我去了老家。").sort(), [
    "event",
    "person",
    "place",
    "time",
  ]);
  assert.deepEqual(detectCoveredDimensions("嗯。"), []);
});

test("the whole family sees the same shared question on the same day", () => {
  // 种子按本地日历日计算，因此用本地时间构造同一天的早晚两个时刻。
  const seed = sharedQuestionSeed(new Date(2026, 7, 28, 8, 0, 0));
  const sameDayLater = sharedQuestionSeed(new Date(2026, 7, 28, 22, 30, 0));
  const nextDay = sharedQuestionSeed(new Date(2026, 7, 29, 8, 0, 0));

  assert.equal(seed, sameDayLater);
  assert.equal(pickSharedQuestion(seed).id, pickSharedQuestion(sameDayLater).id);
  assert.ok(pickSharedQuestion(seed).text.length > 0);
  assert.notEqual(seed, nextDay);
});

test("personal and family interviews use different narrative voices", () => {
  const seed = "2026-08-28";
  const personalQuestion = pickInterviewQuestion(seed, "personal");
  const familyQuestion = pickInterviewQuestion(seed, "family");
  const personalPrompt = nextInterviewPrompt({
    answer: "嗯。",
    askedDimensions: ["person", "time", "place"],
    mode: "personal",
  });

  assert.ok(PERSONAL_QUESTIONS.some((question) => question.id === personalQuestion.id));
  assert.notEqual(personalQuestion.id, familyQuestion.id);
  assert.doesNotMatch(personalPrompt.text, /他|她/);
  assert.match(personalPrompt.text, /你|后来|这件事/);
});

test("the draft title is cut from the speaker's own words, never invented", () => {
  assert.equal(
    draftTitleFromAnswers(["外婆家门口有一口老井，井沿被磨得很亮。"]),
    "外婆家门口有一口老井",
  );
  // 超长的首句会被截断并标出省略，而不是概括成别的说法。
  assert.equal(
    draftTitleFromAnswers(["他那时候在纺织厂上班每天早上四点就起来了"]),
    "他那时候在纺织厂上班每天早上…",
  );
  assert.equal(draftTitleFromAnswers([]), "");
  assert.equal(draftTitleFromAnswers(["   "]), "");
});
