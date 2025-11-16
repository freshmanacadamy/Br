const TelegramBot = require('node-telegram-bot-api');
const chromium = require('chrome-aws-lambda');
const puppeteer = require('puppeteer-core');

// Initialize Telegram bot
const bot = new TelegramBot(process.env.BOT_TOKEN, { webHook: true });

// In-memory user sessions
const userSessions = new Map();

// Webhook flag
let webhookSet = false;

// Set webhook for Vercel
const setWebhook = async () => {
  if (process.env.VERCEL_URL && !webhookSet) {
    const webhookUrl = `https://${process.env.VERCEL_URL}/api/bot`;
    await bot.setWebHook(webhookUrl);
    console.log('Webhook set to:', webhookUrl);
    webhookSet = true;
  }
};

// Function to fetch grades using Puppeteer
async function fetchJUGrades(username, password) {
  let browser;
  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath,
      headless: true,
    });

    const page = await browser.newPage();

    // Navigate to login page
    await page.goto('https://portal.ju.edu.et/login', { waitUntil: 'networkidle2' });

    // Fill username and password
    await page.type('input[type="text"], input[name="username"]', username, { delay: 50 });
    await page.type('input[type="password"]', password, { delay: 50 });

    // Submit the form
    await Promise.all([
      page.click('button[type="submit"], input[type="submit"]'),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 })
    ]);

    // Check if login successful
    const loginFailed = await page.$('.alert-danger, .error, .text-danger');
    if (loginFailed) {
      const errorMsg = await page.evaluate(el => el.innerText, loginFailed);
      return { success: false, error: `Login failed: ${errorMsg}` };
    }

    // Go to grades page
    await page.goto('https://portal.ju.edu.et/student/academic/grade', { waitUntil: 'networkidle2' });

    // Extract grades
    const gradesData = await page.evaluate(() => {
      const studentName = document.querySelector('.student-name, .profile-name, .user-name, .name')?.innerText || 'Student';
      const grades = [];
      document.querySelectorAll('table tr').forEach((row, idx) => {
        if (idx === 0) return; // skip header
        const cells = row.querySelectorAll('td');
        if (cells.length >= 2) {
          grades.push({
            code: cells[0].innerText.trim(),
            name: cells[1].innerText.trim() || 'Course',
            credit: 'N/A',
            grade: cells[cells.length - 1].innerText.trim()
          });
        }
      });
      return { studentName, grades };
    });

    return {
      success: true,
      studentInfo: { name: gradesData.studentName, id: username, program: 'N/A' },
      grades: gradesData.grades,
      cgpa: 'Check portal',
      summary: `Found ${gradesData.grades.length} items`
    };

  } catch (error) {
    console.error('Puppeteer error:', error);
    return { success: false, error: `Login/fetch failed: ${error.message}` };
  } finally {
    if (browser) await browser.close();
  }
}

// Format grades response
function formatGradeResponse(data) {
  if (!data.success) return `❌ *Error*\n\n${data.error}`;
  let response = `🎓 *Jimma University*\n\n`;
  response += `👤 *Name:* ${data.studentInfo.name}\n🆔 *ID:* ${data.studentInfo.id}\n\n`;
  if (data.grades.length > 0) {
    response += `📊 *Results:*\n\`\`\`\n`;
    data.grades.slice(0, 10).forEach(c => response += `${c.code}: ${c.grade}\n`);
    if (data.grades.length > 10) response += `... ${data.grades.length - 10} more\n`;
    response += `\`\`\`\n`;
  } else {
    response += `ℹ️ No grade data found.\n`;
  }
  response += `\n🔄 *Status:* ${data.summary}`;
  return response;
}

// Telegram bot commands
bot.onText(/\/start/, msg => {
  bot.sendMessage(msg.chat.id, `🤖 *JU Grade Bot*\n\nUse /login to check your grades.`, { parse_mode: 'MarkdownV2' });
});

bot.onText(/\/login/, msg => {
  userSessions.set(msg.chat.id, { step: 'awaiting_username' });
  bot.sendMessage(msg.chat.id, 'Enter your JU username:');
});

// Handle user messages
bot.on('message', async msg => {
  const chatId = msg.chat.id;
  const text = msg.text;
  const session = userSessions.get(chatId);
  if (!session || !text || text.startsWith('/')) return;

  if (session.step === 'awaiting_username') {
    session.username = text;
    session.step = 'awaiting_password';
    bot.sendMessage(chatId, 'Enter your password:');
  } else if (session.step === 'awaiting_password') {
    session.password = text;
    session.step = 'logging_in';
    const loadingMsg = await bot.sendMessage(chatId, '⏳ Logging in...');
    try {
      const gradeData = await fetchJUGrades(session.username, session.password);
      session.password = null;
      userSessions.delete(chatId);
      const responseText = formatGradeResponse(gradeData);
      bot.editMessageText(responseText, { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'MarkdownV2' });
    } catch (err) {
      console.error(err);
      bot.editMessageText('❌ Unexpected error.', { chat_id: chatId, message_id: loadingMsg.message_id });
      userSessions.delete(chatId);
    }
  }
});

// Vercel handler
module.exports = async (req, res) => {
  if (process.env.VERCEL_URL && !webhookSet) await setWebhook();

  if (req.method === 'POST') {
    try {
      await bot.processUpdate(req.body);
      res.status(200).json({ status: 'ok' });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  } else {
    res.status(200).json({ status: 'Bot is running' });
  }
};
