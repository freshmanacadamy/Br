const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const cheerio = require('cheerio');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');

// Initialize bot
const bot = new TelegramBot(process.env.BOT_TOKEN, { webHook: true });

// Jimma University Portal URLs
const JU_BASE_URL = 'https://portal.ju.edu.et';
const PORTAL_URLS = {
  login: `${JU_BASE_URL}/login`,
  grades: `${JU_BASE_URL}/student/academic/grade`
};

// Store user sessions (ephemeral)
const userSessions = new Map();

// In-memory webhook flag
let webhookSet = false;

// Set webhook
const setWebhook = async () => {
  if (process.env.VERCEL_URL && !webhookSet) {
    const webhookUrl = `https://${process.env.VERCEL_URL}/api/bot`;
    await bot.setWebHook(webhookUrl);
    console.log('Webhook set to:', webhookUrl);
    webhookSet = true;
  }
};

// Utility: delay
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Function to login and fetch grades with retries
async function fetchJUGrades(username, password, retries = 2) {
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    console.log(`=== LOGIN ATTEMPT ${attempt} ===`);
    try {
      const jar = new CookieJar();
      const session = wrapper(axios.create({
        jar,
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        }
      }));

      // 1. Get login page
      const loginPageResponse = await session.get(PORTAL_URLS.login);
      const $login = cheerio.load(loginPageResponse.data);

      // CSRF token
      const csrfToken = $login('input[name="_token"]').val() || 
                       $login('input[name="csrf_token"]').val() ||
                       $login('meta[name="csrf-token"]').attr('content');

      const usernameField = $login('input[type="text"], input[name="username"], input[name="email"], input[name="login"]').attr('name') || 'username';
      const passwordField = $login('input[type="password"]').attr('name') || 'password';

      const loginData = new URLSearchParams();
      loginData.append(usernameField, username);
      loginData.append(passwordField, password);
      if (csrfToken) loginData.append('_token', csrfToken);

      // 2. Perform login
      const loginResponse = await session.post(PORTAL_URLS.login, loginData, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': PORTAL_URLS.login,
          'Origin': JU_BASE_URL
        },
        maxRedirects: 5
      });

      const $postLogin = cheerio.load(loginResponse.data);
      const isLoggedIn = $postLogin('a[href*="logout"], button[href*="logout"], a[href*="dashboard"]').length > 0;

      if (!isLoggedIn) {
        const errorText = $postLogin('.alert-danger, .error, .text-danger').text().trim() || 'Invalid credentials';
        throw new Error(`Login failed: ${errorText}`);
      }

      // 3. Access grades page
      const gradesResponse = await session.get(PORTAL_URLS.grades);
      const $grades = cheerio.load(gradesResponse.data);
      const gradeData = parseGradeData($grades, username);

      if (!gradeData.success) throw new Error('Grade parsing failed');

      return gradeData;

    } catch (error) {
      console.log(`Attempt ${attempt} failed: ${error.message}`);
      if (attempt <= retries) {
        console.log('Retrying in 2 seconds...');
        await sleep(2000);
      } else {
        return { success: false, error: `Login/Fetch failed after ${attempt} attempts: ${error.message}` };
      }
    }
  }
}

// Parse grade data
function parseGradeData($, username) {
  try {
    const grades = [];
    const studentInfo = {
      name: $('.student-name, .profile-name, .user-name, .name').first().text().trim() || 'Student',
      id: username,
      program: 'N/A'
    };

    $('table').each((i, table) => {
      const rows = $(table).find('tr');
      if (rows.length > 1) {
        rows.each((j, row) => {
          if (j > 0) {
            const cols = $(row).find('td');
            if (cols.length >= 2) {
              const courseCode = $(cols[0]).text().trim();
              const courseName = $(cols[1]).text().trim();
              const grade = $(cols[cols.length - 1]).text().trim();
              if (courseCode && grade) grades.push({ code: courseCode, name: courseName || 'Course', credit: 'N/A', grade });
            }
          }
        });
      }
    });

    if (grades.length === 0) {
      $('body').text().split('\n').forEach(line => {
        const trimmed = line.trim();
        const gradeMatch = trimmed.match(/([A-F][+-]?|[0-4]\.?[0-9]*)$/);
        if (gradeMatch && trimmed.length < 100) grades.push({ code: `C${grades.length + 1}`, name: 'Course', credit: 'N/A', grade: gradeMatch[1] });
      });
    }

    return { success: true, studentInfo, grades, cgpa: 'Check portal', summary: `Found ${grades.length} items` };

  } catch (error) {
    return { success: false, error: 'Could not parse grade data' };
  }
}

// Format grade response
function formatGradeResponse(gradeData) {
  if (!gradeData.success) return `❌ *Error*\n\n${gradeData.error}`;

  let response = `🎓 *Jimma University*\n\n`;
  response += `👤 *Name:* ${gradeData.studentInfo.name}\n`;
  response += `🆔 *ID:* ${gradeData.studentInfo.id}\n\n`;

  if (gradeData.grades.length > 0) {
    response += `📊 *Results:*\n\`\`\`\n`;
    gradeData.grades.slice(0, 10).forEach(course => {
      response += `${course.code}: ${course.grade}\n`;
    });
    if (gradeData.grades.length > 10) response += `... ${gradeData.grades.length - 10} more\n`;
    response += `\`\`\`\n`;
  } else {
    response += `ℹ️ No grade data found.\nYou are logged in but no grades were detected.\n`;
  }

  response += `\n🔄 *Status:* ${gradeData.summary}`;
  return response;
}

// Bot commands
bot.onText(/\/start/, msg => {
  bot.sendMessage(msg.chat.id, `🤖 *JU Grade Bot*\n\nUse /login to check your grades.\n\n*Note:* Debug version.`, { parse_mode: 'MarkdownV2' });
});

bot.onText(/\/login/, msg => {
  userSessions.set(msg.chat.id, { step: 'awaiting_username' });
  bot.sendMessage(msg.chat.id, 'Enter your JU username:');
});

// Handle messages
bot.on('message', async msg => {
  const chatId = msg.chat.id;
  const text = msg.text;
  const userData = userSessions.get(chatId);
  if (!userData || !text || text.startsWith('/')) return;

  if (userData.step === 'awaiting_username') {
    userData.username = text;
    userData.step = 'awaiting_password';
    bot.sendMessage(chatId, 'Enter your password:');

  } else if (userData.step === 'awaiting_password') {
    userData.password = text;
    userData.step = 'logging_in';

    const loadingMsg = await bot.sendMessage(chatId, '⏳ Logging in...');

    try {
      const gradeData = await fetchJUGrades(userData.username, userData.password, 2);
      userData.password = null;
      userSessions.delete(chatId);

      const responseText = formatGradeResponse(gradeData);
      bot.editMessageText(responseText, {
        chat_id: chatId,
        message_id: loadingMsg.message_id,
        parse_mode: 'MarkdownV2'
      });

    } catch (error) {
      console.error('Final error:', error);
      bot.editMessageText('❌ Unexpected error. Check logs.', { chat_id: chatId, message_id: loadingMsg.message_id });
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
    } catch (error) {
      console.error('Handler error:', error);
      res.status(500).json({ error: error.message });
    }
  } else {
    res.status(200).json({ status: 'Bot is running' });
  }
};
