const logger = require('../utils/logger');

const SLACK_POST_MESSAGE_URL = 'https://slack.com/api/chat.postMessage';

/**
 * True once both SLACK_BOT_TOKEN and SLACK_CHANNEL_ID are set. Callers can
 * use this to skip optional Slack-only setup, but sendSlackMessage already
 * no-ops safely on its own when Slack isn't configured.
 */
const isSlackConfigured = () => Boolean(process.env.SLACK_BOT_TOKEN && process.env.SLACK_CHANNEL_ID);

/**
 * Posts a message to the configured Slack channel via the Slack Web API
 * (chat.postMessage). Requires a Bot User OAuth Token with the `chat:write`
 * scope, invited into the target channel.
 *
 * This never throws — a Slack outage or missing config should never break
 * whatever feature triggered the notification. Failures are logged and
 * returned as `{ ok: false }` for callers that want to inspect them.
 *
 * @param {string} text - Plain-text fallback / message body (supports Slack's mrkdwn).
 * @param {object} [options]
 * @param {Array}  [options.blocks] - Optional Slack Block Kit blocks for richer formatting.
 * @param {string} [options.channel] - Override the default channel for this call.
 * @returns {Promise<{ok: boolean, [key: string]: any}>}
 */
const sendSlackMessage = async (text, { blocks, channel } = {}) => {
  const token = process.env.SLACK_BOT_TOKEN;
  const targetChannel = channel || process.env.SLACK_CHANNEL_ID;

  if (!token || !targetChannel) {
    logger.warn('Slack is not configured (missing SLACK_BOT_TOKEN/SLACK_CHANNEL_ID) — skipping message.');
    return { ok: false, skipped: true };
  }

  try {
    const response = await fetch(SLACK_POST_MESSAGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        channel: targetChannel,
        text,
        ...(blocks ? { blocks } : {}),
      }),
    });

    const data = await response.json();

    if (!data.ok) {
      // Slack returns 200 OK with { ok: false, error: '...' } on failure —
      // it's not an HTTP-level error, so this has to be checked explicitly.
      logger.error(`Slack API error: ${data.error}`);
    }

    return data;
  } catch (error) {
    logger.error(`Failed to reach Slack API: ${error.message}`);
    return { ok: false, error: error.message };
  }
};

module.exports = {
  sendSlackMessage,
  isSlackConfigured,
};
