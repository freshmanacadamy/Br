const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const cheerio = require('cheerio');

// Initialize bot
const bot = new TelegramBot(process.env.BOT_TOKEN, { webHook: true });

// Jimma University Portal URLs
const JU_BASE_URL = 'https://portal.ju.edu.et';
const PORTAL_URLS = {
  login: `${JU_BASE_URL}/login`,
  announcement: `${JU_BASE_URL}/announce/show`,
  grades: `${JU_BASE_URL}/student/academic/grade`,
  dashboard: `${JU_BASE_URL}/student/dashboard`
};

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
  let session = null;
  
  try {
    // Create axios session to maintain cookies
    session = axios.create({
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Connection': 'keep-alive'
      },
      maxRedirects: 5
    });

    console.log('Step 1: Getting login page for:', username);

    // Step 1: Get login page to obtain cookies and CSRF token
    const loginPageResponse = await session.get(PORTAL_URLS.login);
    console.log('Login page status:', loginPageResponse.status);
    
    const $login = cheerio.load(loginPageResponse.data);
    
    // Extract CSRF token
    let csrfToken = $login('input[name="_token"]').val();
    console.log('CSRF Token found:', !!csrfToken);

    // Prepare login data
    const loginData = new URLSearchParams();
    loginData.append('username', username);
    loginData.append('password', password);
    
    if (csrfToken) {
      loginData.append('_token', csrfToken);
    }

    console.log('Step 2: Attempting login...');

    // Step 2: Perform login
    const loginResponse = await session.post(PORTAL_URLS.login, loginData, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': PORTAL_URLS.login,
        'Origin': JU_BASE_URL
      }
    });

    console.log('Login response status:', loginResponse.status);

    // Check if login was successful by trying to access grades page
    try {
      console.log('Step 3: Accessing grades page...');
      const gradesResponse = await session.get(PORTAL_URLS.grades);
      
      if (gradesResponse.status === 200) {
        const $grades = cheerio.load(gradesResponse.data);
        const gradeData = parseGradeData($grades, username);
        return gradeData;
      } else {
        return {
          success: false,
          error: 'Access denied to grade page. Please check your credentials.'
        };
      }
    } catch (gradeError) {
      console.log('Grade page access failed, trying dashboard...');
      
      // Try dashboard as fallback
      const dashboardResponse = await session.get(PORTAL_URLS.dashboard);
      const $dashboard = cheerio.load(dashboardResponse.data);
      const dashboardData = parseDashboardData($dashboard, username);
      return dashboardData;
    }

  } catch (error) {
    console.error('Fetch grade error:', error.message);
    
    if (error.response?.status === 401 || error.response?.status === 403) {
      return {
        success: false,
        error: 'Invalid username or password.'
      };
    } else if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
      return {
        success: false,
        error: 'University portal is currently unavailable. Please try again later.'
      };
    } else {
      return {
        success: false,
        error: `Login failed: ${error.message}`
      };
    }
  }
}

// Function to parse grade data from grade page
function parseGradeData($, username) {
  try {
    const grades = [];
    let studentInfo = {
      name: 'Student',
      id: username,
      program: 'N/A'
    };
    
    // Try to extract student information
    studentInfo.name = $('.student-name, .profile-name, .user-name').first().text().trim() || 
                      $('h1, h2, h3').first().text().trim() ||
                      studentInfo.name;

    // Extract grades from tables - look for grade tables specifically
    $('table').each((tableIndex, table) => {
      const $table = $(table);
      const tableText = $table.text().toLowerCase();
      
      // Check if this table likely contains grade information
      if (tableText.includes('grade') || tableText.includes('credit') || 
          tableText.includes('course') || tableText.includes('code') ||
          tableText.includes('subject') || tableText.includes('result')) {
        
        $table.find('tr').each((rowIndex, row) => {
          if (rowIndex > 0) { // Skip header row
            const $row = $(row);
            const cols = $row.find('td');
            
            if (cols.length >= 4) {
              const course = {
                code: $(cols[0]).text().trim() || `C${rowIndex}`,
                name: $(cols[1]).text().trim() || 'Course',
                credit: $(cols[2]).text().trim() || '0',
                grade: $(cols[3]).text().trim() || 'N/A'
              };
              
              // Only add if it looks like a real course
              if (course.code && course.grade && course.grade !== 'N/A') {
                grades.push(course);
              }
            }
          }
        });
      }
    });

    // If no grades found in structured tables, try to find any grade-like data
    if (grades.length === 0) {
      $('td, .grade, .result').each((i, element) => {
        const text = $(element).text().trim();
        const gradeMatch = text.match(/^[A-F][+-]?$|^[0-4]\.?[0-9]*$/);
        if (gradeMatch) {
          grades.push({
            code: `C${i+1}`,
            name: 'Course',
            credit: '0',
            grade: text
          });
        }
      });
    }

    // Extract CGPA/GPA if available
    const pageText = $.text();
    const cgpaMatch = pageText.match(/CGPA:?\s*([0-9]+\.[0-9]+)/i) || 
                     pageText.match(/GPA:?\s*([0-9]+\.[0-9]+)/i) ||
                     pageText.match(/([0-9]+\.[0-9]+)\s*(?:CGPA|GPA)/i);
    
    const cgpa = cgpaMatch ? cgpaMatch[1] : 'Not available';

    return {
      success: true,
      studentInfo: studentInfo,
      grades: grades,
      cgpa: cgpa,
      summary: `Found ${grades.length} course records`
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
      name: $('.user-name, .profile-name, .student-name').first().text().trim() || 'Student',
      id: username,
      program: 'N/A'
    };

    // Look for academic information
    const academicInfo = [];
    $('.card, .panel, .widget, .alert').each((i, element) => {
      const $element = $(element);
      const text = $element.text();
      if (text.includes('GPA') || text.includes('Grade') || text.includes('Credit') || 
          text.includes('Semester') || text.includes('Result')) {
        academicInfo.push(text.replace(/\s+/g, ' ').trim().substring(0, 100));
      }
    });

    return {
      success: true,
      studentInfo: studentInfo,
      grades: [],
      cgpa: 'Check grade portal',
      summary: 'Login successful but could not access grades directly',
      academicInfo: academicInfo.slice(0, 3)
    };
    
  } catch (error) {
    return {
      success: false,
      error: 'Could not access student information.'
    };
  }
}

// Format grade response for Telegram
function formatGradeResponse(gradeData) {
  if (!gradeData.success) {
    return `❌ *Error*\n\n${gradeData.error}\n\nPlease check your credentials and try again.`;
  }

  let response = `🎓 *Jimma University - Grade Report*\n\n`;
  response += `👤 *Name:* ${gradeData.studentInfo.name}\n`;
  response += `🆔 *ID:* ${gradeData.studentInfo.id}\n`;
  response += `📚 *Program:* ${gradeData.studentInfo.program}\n\n`;

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
    
    gradeData.grades.slice(0, 15).forEach(course => {
      response += `${course.code.padEnd(10)} | ${course.grade}\n`;
    });
    
    if (gradeData.grades.length > 15) {
      response += `... and ${gradeData.grades.length - 15} more\n`;
    }
    
    response += `\`\`\`\n`;
    response += `📈 *CGPA/GPA:* ${gradeData.cgpa}\n`;
    response += `📖 *Total Courses:* ${gradeData.grades.length}\n`;
  } else {
    response += `ℹ️ *Note:* ${gradeData.summary}\n`;
    response += `Please visit the portal directly for detailed grades.`;
  }

  response += `\n\n🔄 *Last checked:* ${new Date().toLocaleString()}`;

  return response;
}

// Bot command handlers
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const welcomeMessage = `🤖 *Jimma University Grade Bot*\n\n`
    + `I can help you check your grades from the official JU portal.\n\n`
    + `*Available Commands:*\n`
    + `/login - Login to check your grades\n`
    + `/help - Get help information\n\n`
    + `*How it works:*\n`
    + `1. Use /login with your portal credentials\n`
    + `2. I securely fetch your grades from JU portal\n`
    + `3. View your results directly in Telegram\n\n`
    + `*Privacy:* Your credentials are not stored.`;

  bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'Markdown' });
});

bot.onText(/\/login/, (msg) => {
  const chatId = msg.chat.id;
  userSessions.set(chatId, { step: 'awaiting_username' });
  
  bot.sendMessage(chatId, 
    `🔐 *JU Portal Login*\n\n`
    + `Please enter your JU portal username/ID:`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  const helpMessage = `🆘 *Help Guide*\n\n`
    + `*Login Issues:*\n`
    + `• Use your official JU portal credentials\n`
    + `• Make sure your username and password are correct\n`
    + `• The portal must be accessible\n\n`
    + `*Commands:*\n`
    + `/start - Start the bot\n`
    + `/login - Login to portal\n`
    + `/help - Show this help\n\n`
    + `*Note:* This bot only reads grade information and does not store any data.`;

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
      `✅ Username: ${text}\n\n`
      + `Now please enter your portal password:`
    );
    
  } else if (userData.step === 'awaiting_password' && !text.startsWith('/')) {
    userData.password = text.trim();
    userData.step = 'fetching';
    
    const loadingMsg = await bot.sendMessage(chatId, '⏳ Logging into JU portal...');
    
    try {
      const gradeData = await fetchJUGrades(userData.username, userData.password);
      const responseText = formatGradeResponse(gradeData);
      
      // Clear sensitive data
      userData.password = null;
      userSessions.delete(chatId);
      
      bot.editMessageText(responseText, {
        chat_id: chatId,
        message_id: loadingMsg.message_id,
        parse_mode: 'Markdown'
      });
      
    } catch (error) {
      console.error('Final error:', error);
      bot.editMessageText(
        '❌ An unexpected error occurred. Please try again later.',
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
