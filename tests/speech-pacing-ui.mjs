import assert from 'node:assert/strict'

/** 在已有隔离页面中验证动态倍率、厂商调速路径和配置保存，不读取真实密钥或连接直播。 */
export async function checkSpeechPacing(page) {
  await page.getByRole('link', { name: '音色克隆', exact: true }).click()
  const dynamic = page.getByRole('switch', { name: '动态语速', exact: true })
  const min = page.getByRole('slider', { name: '最低语速', exact: true })
  const max = page.getByRole('slider', { name: '最高语速', exact: true })
  assert.equal(await dynamic.isChecked(), true)
  assert.equal(await min.inputValue(), '0.85')
  assert.equal(await max.inputValue(), '1.15')
  await page
    .getByLabel('试听文字')
    .fill('欢迎大家来到直播间！今天体验价39元。请注意，仅限本人使用。')

  /** 从展示给用户的计划读取倍率，随后与实际合成和播放记录对照。 */
  async function previewRates() {
    await page.getByRole('group', { name: '分句语速预览' }).waitFor({ state: 'visible' })
    return (
      await page
        .getByRole('group', { name: '分句语速预览' })
        .locator('span.font-medium')
        .allTextContents()
    ).map(value => Number(value.replace('×', '')))
  }

  /** 使用内存中的假密钥，让原有页面执行保存和配置状态更新。 */
  async function saveTestKey() {
    await page.locator('#tts-key').fill('test-pacing-key')
    await page.getByRole('button', { name: '保存密钥', exact: true }).click()
    await page.getByText('API Key · 已保存', { exact: true }).waitFor()
  }

  /** 播放完整的三句测试内容，验证调速只发生在一个位置且保持音高。 */
  async function audition(provider, duringSynthesis) {
    const planned = await previewRates()
    await page.evaluate(() => {
      window.voiceTest.requests = []
      window.voiceTest.playback = []
      window.voiceTest.synthesisDelay = 300
    })
    await page.getByRole('button', { name: '合成并播放', exact: true }).click()
    if (duringSynthesis) {
      await page.waitForFunction(() => window.voiceTest.requests.length > 0)
      await duringSynthesis()
    }
    await page.getByText('默认账号 · 等待回复', { exact: true }).waitFor()
    const { requests, playback } = await page.evaluate(() => window.voiceTest)
    assert.equal(requests.length, 3)
    assert.equal(playback.length, 3)
    assert.ok(playback.every(item => item.preservesPitch))
    assert.ok(requests.every(item => item.settings.provider === provider))
    if (provider === 'lanyun') {
      assert.deepEqual(
        requests.map(item => item.settings.speechRate),
        planned,
      )
      assert.deepEqual(
        playback.map(item => item.rate),
        [1, 1, 1],
      )
    } else {
      assert.deepEqual(
        playback.map(item => item.rate),
        planned,
      )
      assert.ok(requests.every(item => item.settings.speechRate === undefined))
    }
    await page.getByRole('button', { name: '停止语音', exact: true }).click()
    return planned
  }

  await saveTestKey()
  const natural = await audition('mimo')
  assert.ok(natural[0] > 1 && natural[1] < 1 && natural[2] < 1)
  await dynamic.uncheck()
  assert.deepEqual(await audition('mimo'), [1, 1, 1])
  await dynamic.check()

  await page.locator('#tts-provider').click()
  await page.getByRole('option', { name: 'OpenAI 兼容语音厂商', exact: true }).click()
  await page.getByLabel('API 基础地址', { exact: true }).fill('https://example.com/v1')
  await page.getByLabel('模型', { exact: true }).fill('test-model')
  await page.getByLabel('音色', { exact: true }).fill('test-voice')
  await saveTestKey()
  assert.deepEqual(await audition('openai-compatible'), natural)

  await page.locator('#tts-provider').click()
  await page.getByRole('option', { name: '蓝云 TTS（IndexTTS-2.5）', exact: true }).click()
  await page.getByLabel('音色 ID', { exact: true }).fill('test-voice')
  await saveTestKey()
  assert.equal(await page.getByLabel('语速倍率', { exact: true }).isDisabled(), true)
  await dynamic.uncheck()
  await page.getByLabel('语速倍率', { exact: true }).fill('1.3')
  assert.deepEqual(await audition('lanyun'), [1.3, 1.3, 1.3])
  await dynamic.check()
  assert.deepEqual(await audition('lanyun'), natural)
  assert.equal(await page.getByLabel('语速倍率', { exact: true }).inputValue(), '1.3')

  for (let count = 0; count < 5; count++) {
    await min.press('ArrowRight')
    await max.press('ArrowLeft')
  }
  assert.equal(await min.inputValue(), '0.9')
  assert.equal(await max.inputValue(), '1.1')
  await page.getByLabel('整体节奏', { exact: true }).click()
  await page.getByRole('option', { name: '舒缓陪伴', exact: true }).click()
  await page
    .getByLabel('直播间播报要求（选填）', { exact: true })
    .fill('自习室，安静舒缓，不要太快')
  const calm = await audition('lanyun', async () => {
    await page.getByLabel('整体节奏', { exact: true }).click()
    await page.getByRole('option', { name: '轻快互动', exact: true }).click()
    await page.getByLabel('直播间播报要求（选填）', { exact: true }).fill('活泼轻快')
  })
  assert.ok(calm.every(rate => rate >= 0.9 && rate <= 1.1))
  const upbeat = await audition('lanyun')
  assert.ok(upbeat.every((rate, index) => rate > calm[index]))
  await page.screenshot({ path: 'test-results/dynamic-speech-pacing.png', fullPage: true })

  await page.reload()
  await page.waitForLoadState('networkidle')
  assert.equal(await dynamic.isChecked(), true)
  assert.equal(await min.inputValue(), '0.9')
  assert.equal(await max.inputValue(), '1.1')
  assert.equal(await page.getByLabel('整体节奏', { exact: true }).innerText(), '轻快互动')
  assert.equal(
    await page.getByLabel('直播间播报要求（选填）', { exact: true }).inputValue(),
    '活泼轻快',
  )
  assert.equal(await page.getByLabel('语速倍率', { exact: true }).inputValue(), '1.3')
  assert.equal(await page.getByRole('button', { name: '停止语音', exact: true }).count(), 0)

  // 模拟升级前没有节奏配置的已保存账号，旧话术和厂商配置必须保留。
  await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('voice-config'))
    delete saved.state.contexts.default.speechPacing
    saved.state.contexts.default.openingScript = '升级前保存的开场内容。'
    localStorage.setItem('voice-config', JSON.stringify(saved))
  })
  await page.reload()
  await page.waitForLoadState('networkidle')
  assert.equal(await min.inputValue(), '0.85')
  assert.equal(await max.inputValue(), '1.15')
  assert.equal(await dynamic.isChecked(), true)
  assert.equal(await page.getByLabel('音色 ID', { exact: true }).inputValue(), 'test-voice')
  await page.getByRole('navigation').getByRole('link', { name: '直播话术', exact: true }).click()
  assert.equal(
    await page.getByLabel('开场介绍', { exact: true }).inputValue(),
    '升级前保存的开场内容。',
  )
}
