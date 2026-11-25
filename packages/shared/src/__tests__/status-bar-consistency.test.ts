/**
 * 对账测试：我们定的格式和规则（模板、样式规格）与状态模型提示词、解析器、校验器必须完全对得上。
 * 任何一处改了没同步，这里就会失败。
 */
import { describe, expect, it } from 'vitest';
import {
  STATUS_BAR_EXAMPLES,
  STATUS_BAR_LIMITS,
  STATUS_BAR_SPEC,
  STATUS_BAR_STYLES,
  STATUS_EMPTY_VALUE,
  STATUS_FILL_BLANK,
  STATUS_SYSTEM_PROMPT,
  StatusBarTemplateDraftSchema,
  buildStatusPromptMessages,
  checkStatusBarTemplate,
  isDeltaStyle,
  isListStyle,
  parseStatusBody,
  statusDefinitionChars,
  statusInitialText,
  statusRepeatTitleIsName,
  statusCarriedItems,
  statusSkeletonText,
  statusValueMatches,
  statusValueRenders,
  validateStatusOutput,
  type StatusBarItem,
  type StatusBarStyle,
  type StatusBarTemplate,
} from '../index';

function sampleItem(style: StatusBarStyle): StatusBarItem {
  const base = {
    id: `t-${style}`,
    name: `项目${STATUS_BAR_STYLES.indexOf(style)}`,
    style,
    desc: '她对你的心动程度，你温柔会涨，冷落会掉，每轮最多变5。',
  };
  if (style === 'bar') return { ...base, max: 200 };
  if (style === 'stars') return { ...base, total: 6 };
  if (style === 'number') return { ...base, unit: '金币' };
  if (style === 'stage') return { ...base, stages: ['陌生', '熟悉', '暧昧', '恋人'] };
  return base;
}

/** 按提示词教的写法填满骨架：每人一组的分区换成真名，数值类带变化量。 */
function modelLikeOutput(template: StatusBarTemplate): string {
  const lines = ['[status]'];
  for (const section of template.sections) {
    const groups = section.repeat ? ['林晚', '苏棠'].slice(0, section.repeat.max) : [section.title];
    for (const title of groups) {
      if (title) lines.push(`【${title}】`);
      for (const item of section.items) {
        const example = STATUS_BAR_SPEC[item.style].example(item);
        if (isListStyle(item.style)) lines.push(`${item.name}：`, ...example.split('\n'));
        else lines.push(`${item.name}：${example}${isDeltaStyle(item.style) ? '（+3）' : ''}`);
      }
    }
  }
  lines.push('[/status]');
  return lines.join('\n');
}

describe('样式规格自洽：提示词的写法例子，解析器都认', () => {
  it.each(STATUS_BAR_STYLES)('%s', (style) => {
    const item = sampleItem(style);
    const example = STATUS_BAR_SPEC[style].example(item);
    if (isListStyle(style)) {
      const parsed = parseStatusBody(`${item.name}：\n${example}`);
      expect(parsed.format === 'v2' && parsed.noteCount).toBe(0);
    } else {
      expect(statusValueMatches(item, example)).toBe(true);
      // 提示词教的写法，面板也按这个样式的组件显示（质量监控的"显示错位"不会误报）
      expect(statusValueRenders(item, example)).toBe(true);
      if (isDeltaStyle(style)) expect(statusValueMatches(item, `${example}（+3）`)).toBe(true);
    }
    expect(statusValueMatches(item, STATUS_EMPTY_VALUE)).toBe(true);
  });

  it('模板参数对不上就不认（上限、满星数、阶段名）', () => {
    expect(statusValueMatches(sampleItem('bar'), '30/100')).toBe(false);
    expect(statusValueMatches(sampleItem('stars'), '★★☆☆☆')).toBe(false);
    expect(statusValueMatches(sampleItem('stage'), '同居（4/4）')).toBe(false);
    expect(statusValueMatches(sampleItem('stage'), '暧昧（3/4）')).toBe(true);
  });

  it('系统提示词里的约定与解析器一致', () => {
    expect(STATUS_SYSTEM_PROMPT).toContain('[status]');
    expect(STATUS_SYSTEM_PROMPT).toContain('[/status]');
    expect(STATUS_SYSTEM_PROMPT).toContain('名称：内容');
    expect(STATUS_SYSTEM_PROMPT).toContain(`"${STATUS_EMPTY_VALUE}"`);
    expect(STATUS_SYSTEM_PROMPT).toContain('（+3）');
  });
});

describe.each(STATUS_BAR_EXAMPLES.map((example) => [example.label, example.template] as const))(
  '示例「%s」',
  (_label, template) => {
    it('结构和语义校验都通过', () => {
      expect(StatusBarTemplateDraftSchema.safeParse(template).success).toBe(true);
      expect(checkStatusBarTemplate(template)).toEqual([]);
      expect(statusDefinitionChars(template)).toBeLessThanOrEqual(
        STATUS_BAR_LIMITS.definitionMaxChars
      );
    });

    it('提示词里带上了每一项的写法和说明、以及骨架', () => {
      const { user } = buildStatusPromptMessages({
        character: { name: '林晚' },
        template,
        previous: null,
        turns: [{ index: 1, user: '你好', reply: '她看了你一眼。' }],
      });
      expect(user).toContain(statusSkeletonText(template));
      for (const section of template.sections)
        for (const item of section.items) {
          expect(user).toContain(STATUS_BAR_SPEC[item.style].format(item));
          expect(user).toContain(item.desc);
        }
    });

    it('骨架和开局文本都能被解析器完整吃下', () => {
      const skeleton = parseStatusBody(
        statusSkeletonText(template).replace('[status]', '').replace('[/status]', '')
      );
      const initial = parseStatusBody(statusInitialText(template));
      expect(skeleton.format === 'v2' && skeleton.noteCount).toBe(0);
      expect(initial.format === 'v2' && initial.noteCount).toBe(0);
    });

    it('按提示词写法填出来的输出校验为 ok，且规范文本可再解析', () => {
      const result = validateStatusOutput(
        template,
        modelLikeOutput(template),
        statusInitialText(template)
      );
      expect(result.issues).toEqual([]);
      expect(result.outcome).toBe('ok');
      expect(result.matchedCount).toBe(result.expectedCount);
      const again = parseStatusBody(result.text ?? '');
      expect(again.format === 'v2' && again.noteCount).toBe(0);
    });

    it('全部写"暂无"也合法', () => {
      const output = modelLikeOutput(template)
        .replace(/：.+$/gm, `：${STATUS_EMPTY_VALUE}`)
        .replace(/^(\[[ x]\]|- ).*\n/gm, '');
      expect(validateStatusOutput(template, output, null).outcome).toBe('ok');
    });
  }
);

describe('输出校验：缺项沿用、写错重试', () => {
  const template = STATUS_BAR_EXAMPLES.find((example) => example.id === 'desire')!.template;
  const previous = validateStatusOutput(template, modelLikeOutput(template), null).text!;

  it('缺项由上次记录沿用，结果为 partial 并给出问题', () => {
    const output = modelLikeOutput(template).replace(/^衣着：.*\n/gm, '');
    const result = validateStatusOutput(template, output, previous);
    expect(result.outcome).toBe('partial');
    expect(result.issues.some((issue) => issue.includes('缺了「衣着」'))).toBe(true);
    expect(result.text).toContain('衣着：她家客厅的沙发上');
  });

  it('写法不对的项给出正确写法', () => {
    const output = modelLikeOutput(template).replace(/^好感：.*$/gm, '好感：44');
    const result = validateStatusOutput(template, output, previous);
    expect(
      result.issues.some(
        (issue) => issue.includes('「好感」写法不对') && issue.includes('当前值/100')
      )
    ).toBe(true);
  });

  it('旧格式与空输出直接失败', () => {
    expect(
      validateStatusOutput(template, '<details><summary>x</summary></details>', previous).outcome
    ).toBe('failed');
    expect(validateStatusOutput(template, '好的，我来更新状态。', null).outcome).toBe('failed');
  });

  it('没有替换占位名要指出来', () => {
    const output = modelLikeOutput(template).replace('【林晚】', '【人物名】');
    expect(
      validateStatusOutput(template, output, previous).issues.some((issue) =>
        issue.includes('换成真实名字')
      )
    ).toBe(true);
  });
});

describe('每人一组：作者直接写了真名', () => {
  const base = STATUS_BAR_EXAMPLES.find((example) => example.id === 'desire')!.template;
  // 作者把占位名直接写成了真名，且只有一组（线上「林雪儿」这类卡）
  const template: StatusBarTemplate = {
    ...base,
    sections: base.sections.map((section) =>
      section.repeat
        ? { ...section, title: '林晚', repeat: { ...section.repeat, max: 1 } }
        : section
    ),
  };
  const options = { repeatTitleIsName: true };
  const previous = validateStatusOutput(template, modelLikeOutput(template), null, options).text!;

  it('标题出现在角色资料里才算真名', () => {
    expect(statusRepeatTitleIsName(template, '林晚，二十四岁，你的邻居')).toBe(true);
    expect(statusRepeatTitleIsName(base, '林晚，二十四岁，你的邻居')).toBe(false);
    expect(statusRepeatTitleIsName(template, '你的邻居')).toBe(false);
  });

  it('照写真名算全对，不要求换名', () => {
    const result = validateStatusOutput(template, modelLikeOutput(template), previous, options);
    expect(result.outcome).toBe('ok');
    expect(result.problems.placeholderTitle).toBe(0);
  });

  it('写歪的项沿用上次记录，不变成"暂无"', () => {
    const output = modelLikeOutput(template).replace(/^好感：.*$/gm, '好感：44');
    const result = validateStatusOutput(template, output, previous, options);
    expect(result.outcome).toBe('partial');
    expect(result.text).toMatch(/^好感：(?!暂无).+$/m);
    expect(result.text).toBe(previous);
  });

  it('不当真名时（占位名）仍要求替换', () => {
    const result = validateStatusOutput(template, modelLikeOutput(template), previous);
    expect(result.issues.some((issue) => issue.includes('换成真实名字'))).toBe(true);
    expect(result.problems.placeholderTitle).toBe(1);
  });
});

describe('没过检查的原因分类（只记类型和数量）', () => {
  const template = STATUS_BAR_EXAMPLES.find((example) => example.id === 'desire')!.template;
  const previous = validateStatusOutput(template, modelLikeOutput(template), null).text!;

  it('缺项、写法不对、多余的行、组数超限分别计数', () => {
    // 输出按两组写，模板只许一组
    const oneGroup: StatusBarTemplate = {
      ...template,
      sections: template.sections.map((section) =>
        section.repeat ? { ...section, repeat: { ...section.repeat, max: 1 } } : section
      ),
    };
    const output = modelLikeOutput(template)
      .replace(/^衣着：.*\n/gm, '')
      .replace(/^好感：.*$/gm, '好感：44')
      .replace('[status]\n', '[status]\n随便写的一句话\n');
    const { problems } = validateStatusOutput(oneGroup, output, previous);
    expect(problems.missing).toBeGreaterThanOrEqual(1);
    expect(problems.badFormat).toContain('bar');
    expect(problems.strayLines).toBe(1);
    expect(problems.extraGroups).toBeGreaterThanOrEqual(1);
  });

  it('全对时没有问题', () => {
    const { problems } = validateStatusOutput(template, modelLikeOutput(template), previous);
    expect(problems).toEqual({
      missing: 0,
      badFormat: [],
      placeholderTitle: 0,
      extraGroups: 0,
      strayLines: 0,
    });
  });
});

describe('说明的填空模板与说明校验一致', () => {
  it.each(STATUS_BAR_STYLES)('%s：没填完不合格，填完合格', (style) => {
    const item = sampleItem(style);
    const template: StatusBarTemplate = {
      version: 1,
      note: '',
      sections: [
        {
          id: 's',
          title: '',
          repeat: null,
          items: [{ ...item, desc: STATUS_BAR_SPEC[style].fillTemplate }],
        },
      ],
    };
    expect(STATUS_BAR_SPEC[style].fillTemplate).toContain(STATUS_FILL_BLANK);
    expect(checkStatusBarTemplate(template).some((issue) => issue.code === 'DESC_UNFILLED')).toBe(
      true
    );
    const filled = STATUS_BAR_SPEC[style].fillTemplate.split(STATUS_FILL_BLANK).join('剧情');
    const ok = {
      ...template,
      sections: [{ ...template.sections[0]!, items: [{ ...item, desc: filled }] }],
    };
    expect(checkStatusBarTemplate(ok)).toEqual([]);
  });

  it('数值类说明没写涨跌要提示', () => {
    const item = { ...sampleItem('bar'), desc: '她对你的心动程度，非常重要' };
    const template: StatusBarTemplate = {
      version: 1,
      note: '',
      sections: [{ id: 's', title: '', repeat: null, items: [item] }],
    };
    expect(checkStatusBarTemplate(template).map((issue) => issue.code)).toContain(
      'DESC_NO_DIRECTION'
    );
  });

  it('开局值写法对不上样式要提示', () => {
    const item = { ...sampleItem('bar'), init: '30/100' };
    const template: StatusBarTemplate = {
      version: 1,
      note: '',
      sections: [{ id: 's', title: '', repeat: null, items: [item] }],
    };
    expect(checkStatusBarTemplate(template).map((issue) => issue.code)).toContain('INIT_MISMATCH');
  });
});

describe('面板最终显示：逐项结果与所在层（质量监控）', () => {
  const template = STATUS_BAR_EXAMPLES.find((example) => example.id === 'desire')!.template;
  const previous = validateStatusOutput(template, modelLikeOutput(template), null).text!;
  const count = (items: { result: string }[], result: string) =>
    items.filter((item) => item.result === result).length;

  it('全对：每一项都是 fresh，停在 ok 层', () => {
    const result = validateStatusOutput(template, modelLikeOutput(template), previous);
    expect(result.stage).toBe('ok');
    expect(result.items).toHaveLength(result.expectedCount);
    expect(count(result.items, 'fresh')).toBe(result.expectedCount);
  });

  it('写法过了校验、但面板会画成别的组件：记为显示错位，不影响校验结论', () => {
    const output = modelLikeOutput(template).replace(/^时间：.*$/m, '时间：3/5');
    const result = validateStatusOutput(template, output, previous);
    expect(result.outcome).toBe('ok');
    expect(result.items).toContainEqual({ style: 'line', result: 'kind_mismatch' });
    expect(count(result.items, 'kind_mismatch')).toBe(1);
  });

  it('标签只写一个短词显示为普通文字，不算错位', () => {
    const output = modelLikeOutput(template).replace(/^身体反应：.*$/gm, '身体反应：紧张');
    const result = validateStatusOutput(template, output, previous);
    expect(count(result.items, 'kind_mismatch')).toBe(0);
  });

  it('缺项沿用记为 carried，停在 content 层；写"暂无"单列 empty', () => {
    const output = modelLikeOutput(template)
      .replace(/^衣着：.*\n/gm, '')
      .replace(/^地点：.*$/m, `地点：${STATUS_EMPTY_VALUE}`);
    const result = validateStatusOutput(template, output, previous);
    expect(result.stage).toBe('content');
    expect(count(result.items, 'carried')).toBe(2);
    expect(result.items).toContainEqual({ style: 'line', result: 'empty' });
  });

  it('这次一组人物都没写：沿用上次的组，组内各项都算 carried', () => {
    const output = modelLikeOutput(template).replace(/【林晚】[\s\S]*(?=\[\/status\])/, '');
    const result = validateStatusOutput(template, output, previous);
    const groupItems = template.sections.find((section) => section.repeat)!.items.length;
    expect(count(result.items, 'carried')).toBe(groupItems * 2);
    expect(count(result.items, 'fresh')).toBe(2);
  });

  it('旧格式、整段散文认不出是状态栏：停在 format 层，全部沿用', () => {
    const legacy = validateStatusOutput(template, '<details>x</details>', previous);
    expect(legacy.stage).toBe('format');
    expect(legacy.items).toEqual(statusCarriedItems(template));
    expect(validateStatusOutput(template, '好的，我来更新状态。', previous).stage).toBe('format');
  });
});
