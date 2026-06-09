const express = require('express');
const { getSetting, setSetting, DEFAULT_SYSTEM_PROMPT } = require('../../lib/settings');
const router = express.Router();

router.get('/settings', (req, res) => {
  const systemPrompt = getSetting('system_prompt', DEFAULT_SYSTEM_PROMPT);
  res.render('admin/settings', { systemPrompt, defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT, saved: req.query.saved, error: null });
});

router.post('/settings', (req, res) => {
  const { system_prompt } = req.body;
  const trimmed = (system_prompt || '').trim();
  if (!trimmed) {
    return res.render('admin/settings', {
      systemPrompt: system_prompt,
      defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT,
      saved: null,
      error: 'SYSTEM PROMPT 不可為空',
    });
  }
  setSetting('system_prompt', trimmed);
  res.redirect('/admin/settings?saved=1');
});

module.exports = router;
