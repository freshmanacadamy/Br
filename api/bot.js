const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const cheerio = require('cheerio');

// Initialize bot
const bot = new TelegramBot(process.env.BOT_TOKEN, { webHook: true });

// Jimma University Portal URL
const JU_PORTAL_URL = 'https://portal.ju.edu.et';

// Store user sessions temporarily
const userSessions = new Map();

// Set webhook
const setWebhook = async () => {
  if (process.env.VERCEL_URL) {
    const webhookUrl = `${process.env.VERCEL_URL}/api/bot`;
    await bot.setWebHook(webhookUrl);
    console.log('Webhook set to:', webhookUrl);
  }
};

// Function to login and fetch grades from JU portal
async function fetchJUGrades(username, password) {
  try {
    // Create axios session to maintain cookies
    const session = axios.create({
      baseURL: JU_PORTAL_URL,
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    console.log('Attempting login for:', username);

    // Step 1: Get login page to obtain cookies and any tokens
    const loginPageResponse = await session.get('/login');
    const $login = cheerio.load(loginPageResponse.data);

    // Extract CSRF token or any hidden fields (common in Laravel apps)
    const csrfToken = $login('input[name="_token"]').val() || 
                     $login('meta[name="csrf-token"]').attr('content');

    // Step 2: Perform login
    const loginData = {
      username: username,
      password: password,
      _token: csrfToken
    };

    const loginResponse = await session.post('/login', loginData, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': `${JU_PORTAL_URL}/login`
      },
      maxRedirects: 5
    });

    // Check if login was successful
    if (loginResponse.request?.res?.responseUrl?.includes('dashboard') || 
        loginResponse.data?.includes('dashboard') ||
        loginResponse.status === 200) {
      
      console.log('Login successful for:', username);

      // Step 3: Navigate to grades/transcript page
      // Common grade page URLs in university portals
      const gradeUrls = [
        '/student/grade',
        '/student/grades',
        '/student/transcript',
        '/grades',
        '/transcript',
        '/student/academic-record'
      ];

      let gradeData = null;

      for (const gradeUrl of gradeUrls) {
        try {
          const gradeResponse = await session.get(gradeUrl);
          const $grades = cheerio.load(gradeResponse.data);
          
          // Parse grade information - adjust selectors based on actual portal structure
          gradeData = parseGradeData($grades);
          if (gradeData.success) break;
        } catch (error) {
          console.log(`Tried ${gradeUrl}:`, error.message);
          continue;
        }
      }

      if (!gradeData) {
        // If specific grade pages don't work, try dashboard for basic info
        const dashboardResponse = await session.get('/student/dashboard');
        const $dashboard = cheerio.load(dashboardResponse.data);
        gradeData = parseDashboardData($dashboard, username);
      }

      return gradeData;

    } else {
      return {
        success: false,
        error: 'Login failed. Please check your username and password.'
      };
    }

  } catch (error) {
    console.error('Fetch grade error:', error.response?.data || error.message);
    
    if (error.response?.status === 401) {
      return {
        success: false,
        error: 'Invalid username or password.'
      };
    } else if (error.code === 'ECONNREFUSED') {
      return {
        success: false,
        error: 'University portal is currently unavailable. Please try again later.'
      };
    } else {
      return {
        success: false,
        error: 'Failed to connect to university portal. Please try again later.'
      };
    }
  }
}

// Function to parse grade data from grade page
function parseGradeData($) {
  try {
    const grades = [];
    let studentInfo = {};
    
    // Extract student information (common selectors)
    studentInfo.name = $('.student-name, .profile-name, [class*="name"]').first().text().trim() || 
                      $('h1, h2, h3').filter((i, el) => $(el).text().includes('Name')).next().text().trim();
    
    studentInfo.id = $('.student-id, .registration-no, [class*="id"]').first().text().trim();
    studentInfo.program = $('.program, .department, [class*="program"]').first().text().trim();
    
    // Extract grades from tables (common patterns)
    $('table').each((tableIndex, table) => {
      const $table = $(table);
      const headers = [];
      
      // Get table headers
      $table.find('thead th, tr:first th').each((i, th) => {
        headers.push($(th).text().trim().toLowerCase());
      });
      
      // Look for grade-related headers
      const isGradeTable = headers.some(header => 
        header.includes('grade') || header.includes('credit') || 
        header.includes('course') || header.includes('code')
      );
      
      if (isGradeTable) {
        $table.find('tbody tr, tr:not(:first)').each((i, row) => {
          const $row = $(row);
          const cols = $row.find('td');
          
          if (cols.length >= 3) {
            const course = {
              code: $(cols[0]).text().trim(),
              name: $(cols[1]).text().trim(),
              credit: $(cols[2]).text().trim(),
              grade: $(cols[3] || cols[2]).text().trim()
            };
            
            if (course.code && course.grade) {
              grades.push(course);
            }
          }
        });
      }
    });
    
    // Extract CGPA/GPA
    const cgpa = $('.cgpa, .gpa, [class*="gpa"]').first().text().trim() ||
                 $('strong, b').filter((i, el) => $(el).text().includes('GPA') || $(el).text().includes('CGPA')).parent().text().match(/\d+\.\d+/)?.[0];
    
    return {
      success: true,
      studentInfo: studentInfo,
      grades: grades,
      cgpa: cgpa || 'Not available',
      summary: `Found ${grades.length} courses`
    };
    
  } catch (error) {
    console.error('Parse grade error:', error);
    return {
      success: false,
      error: 'Could not parse grade information from portal.'
    };
  }
}

// Function to parse data from dashboard
function parseDashboardData($, username) {
  try {
    const studentInfo = {
      name: $('.user-name, .profile-name').first().text().trim() || 'Student',
      id: username
    };
    
    // Look for any academic information on dashboard
    const academicInfo = [];
    $('.card, .panel, .widget').each((i, element) => {
      const $element = $(element);
      const text = $element.text();
      if (text.includes('GPA') || text.includes('Grade') || text.includes('Credit')) {
        academicInfo.push(text.trim());
      }
    });
    
    return {
      success: true,
      studentInfo: studentInfo,
      grades: [],
      cgpa: 'Check grade portal',
      summary: 'Accessed dashboard. Use university portal for detailed grades.',
      academicInfo: academicInfo
    };
    
  } catch (error) {
    return {
      success: false,
      error: 'Could not access academic information.'
    };
  }
}

// Format grade response for Telegram
function formatGradeResponse(gradeData) {
  if (!gradeData.success) {
    return `❌ *Error*\n\n${gradeData.error}`;
  }

  let response = `🎓 *Jimma University - Grade Report*\n\n`;
  response += `👤 *Name:* ${gradeData.studentInfo.name || 'N/A'}\n`;
  response += `🆔 *ID:* ${gradeData.studentInfo.id || 'N/A'}\n`;
  response += `📚 *Program:* ${gradeData.studentInfo.program || 'N/A'}\n\n`;

  if (gradeData.academicInfo && gradeData.academicInfo.length > 0) {
    response += `📋 *Academic Information:*\n`;
    gradeData.academicInfo.forEach(info => {
      response += `• ${info}\n`;
    });
    response += `\n`;
  }

  if (gradeData.grades.length > 0) {
    response += `📊 *Course Grades:*\n\`\`\`\n`;
    response += `Code       | Grade\n`;
    response += `---------- | -----\n`;
    
    gradeData.grades.slice(0, 15).forEach(course => { // Limit to 15 courses
      response += `${(course.code || '').substring(0, 10).padEnd(10)} | ${course.grade}\n`;
    });
    
    response += `\`\`\`\n`;
    response += `📈 *CGPA/GPA:* ${gradeData.cgpa}\n`;
    response += `📖 *Total Courses:* ${gradeData.grades.length}\n`;
  } else {
    response += `ℹ️ *Note:* ${gradeData.summary || 'No detailed grades found.'}\n`;
    response += `Please check your grades directly on the university portal.`;
  }

  response += `\n\n🔄 *Last Updated:* ${new Date().toLocaleDateString()}`;

  return response;
}

// Bot command handlers
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const welcomeMessage = `🤖 *Jimma University Grade Bot*\n\n`
    + `I can help you check your grades from the official JU portal.\n\n`
    + `*How to use:*\n`
    + `1. Use /login to enter your portal credentials\n`
    + `2. I'll fetch your latest grades securely\n`
    + `3. View your academic progress\n\n`
    + `*Privacy:* Your credentials are not stored and are only used for this session.`;

  bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'Markdown' });
});

bot.onText(/\/login/, (msg) => {
  const chatId = msg.chat.id;
  userSessions.set(chatId, { step: 'awaiting_username' });
  
  bot.sendMessage(chatId, 
    `🔐 *JU Portal Login*\n\n`
    + `Please enter your Jimma University portal username:`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/grades/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId,
    `📊 To view your grades, please login first using /login command.`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  const helpMessage = `🆘 *Help Guide*\n\n`
    + `*Commands:*\n`
    + `/start - Start the bot\n`
    + `/login - Login to JU portal\n`
    + `/grades - View your grades\n`
    + `/help - This help message\n\n`
    + `*Note:*\n`
    + `• Use your official JU portal credentials\n`
    + `• System follows JU's security protocols\n`
    + `• Your data is not stored on our servers`;

  bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
});

// Handle credential input
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  const userData = userSessions.get(chatId);

  if (!userData || userData.step === undefined) return;

  if (userData.step === 'awaiting_username' && !text.startsWith('/')) {
    userData.username = text.trim();
    userData.step = 'awaiting_password';
    
    bot.sendMessage(chatId,
      `✅ Username saved\n\n`
      + `Now please enter your portal password:`
    );
    
  } else if (userData.step === 'awaiting_password' && !text.startsWith('/')) {
    userData.password = text.trim();
    userData.step = 'fetching';
    
    const loadingMsg = await bot.sendMessage(chatId, '⏳ Logging into JU portal...');
    
    try {
      const gradeData = await fetchJUGrades(userData.username, userData.password);
      const responseText = formatGradeResponse(gradeData);
      
      // Clear password from memory
      userData.password = null;
      userSessions.delete(chatId);
      
      bot.editMessageText(responseText, {
        chat_id: chatId,
        message_id: loadingMsg.message_id,
        parse_mode: 'Markdown'
      });
      
    } catch (error) {
      bot.editMessageText(
        '❌ An error occurred while fetching grades. Please try again later.',
        {
          chat_id: chatId,
          message_id: loadingMsg.message_id
        }
      );
      
      userSessions.delete(chatId);
    }
  }
});

// Error handling
bot.on('error', (error) => {
  console.error('Bot error:', error);
});

// Vercel serverless function handler
module.exports = async (req, res) => {
  // Set webhook on first run
  if (process.env.VERCEL_URL && !process.env.WEBHOOK_SET) {
    await setWebhook();
    process.env.WEBHOOK_SET = 'true';
  }

  if (req.method === 'POST') {
    try {
      const update = req.body;
      await bot.processUpdate(update);
      res.status(200).json({ status: 'ok' });
    } catch (error) {
      console.error('Error processing update:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  } else {
    res.status(200).json({ 
      message: 'Jimma University Grade Bot is running!',
      timestamp: new Date().toISOString()
    });
  }
};
