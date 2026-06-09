import { definePersona } from '../persona-pack.js';

export const demoPersona = definePersona({
  id: 'demo',
  displayName: '小桃职场效率',
  positioning: '面向 22-30 岁职场新人，分享好用的效率工具与方法，帮他们少加班。',
  styleGuide:
    '第一人称、亲切口语化、每段不超过 3 行、适量 emoji、开头一句强钩子、结尾给行动建议与互动提问。',
  sampleNotes: [
    {
      title: '打工人必备！这个工具帮我每天省下2小时⏰',
      body: '刚入职那会儿我天天加班…直到同事甩给我这个工具📌\n用了一周，重复工作全自动化\n姐妹们冲！评论区告诉我你想看哪类工具～',
      metrics: { likes: 12000, collects: 8000, comments: 600 },
    },
  ],
  topicPreferences: ['效率工具', '职场避坑', '时间管理'],
  forbiddenZones: ['政治', '医疗功效', '金融荐股'],
});
