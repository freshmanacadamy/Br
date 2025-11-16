const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const cheerio = require('cheerio');

// Initialize bot
const bot = new TelegramBot(process.env.BOT_TOKEN, { webHook: true });

// Jimma University Portal URLs
const JU_BASE_URL = 'https://portal.ju.edu.et';
const PORTAL_URLS = {
login: ${JU_BASE_URL}/login,
grades: ${JU_BASE_URL}/student/academic/grade
};

// Store user sessions
const userSessions = new Map();

// Set webhook
const setWebhook = async () => {
if (process.env.VERCEL_URL) {
const webhookUrl = ${process.env.VERCEL_URL}/api/bot;
await bot.setWebHook(webhookUrl);
console.log('Webhook set to:', webhookUrl);
}
};

// Function to login and fetch grades
async function fetchJUGrades(username, password) {
console.log('=== STARTING LOGIN PROCESS ===');

try {
// Create axios instance with better configuration
const session = axios.create({
timeout: 15000,
headers: {
'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,/;q=0.8',
'Accept-Language': 'en-US,en;q=0.9',
}
});

console.log('1. Fetching login page...');  
  
// Get login page  
const loginPageResponse = await session.get(PORTAL_URLS.login);  
console.log('   Login page status:', loginPageResponse.status);  
  
const $login = cheerio.load(loginPageResponse.data);  
  
// Debug: Check page content  
const pageTitle = $login('title').text();  
console.log('   Page title:', pageTitle);  
  
// Find all form inputs for debugging  
const formInputs = [];  
$login('input').each((i, elem) => {  
  formInputs.push({  
    name: $(elem).attr('name'),  
    type: $(elem).attr('type'),  
    value: $(elem).attr('value')  
  });  
});  
console.log('   Form inputs found:', formInputs);  

// Get CSRF token from common locations  
const csrfToken = $login('input[name="_token"]').val() ||   
                 $login('input[name="csrf_token"]').val() ||  
                 $login('meta[name="csrf-token"]').attr('content');  
console.log('   CSRF token:', csrfToken ? 'Found' : 'Not found');  

// Find username and password fields  
const usernameField = $login('input[type="text"], input[name="username"], input[name="email"], input[name="login"]').attr('name') || 'username';  
const passwordField = $login('input[type="password"]').attr('name') || 'password';  
  
console.log('   Username field:', usernameField);  
console.log('   Password field:', passwordField);  

// Prepare login data  
const loginData = new URLSearchParams();  
loginData.append(usernameField, username);  
loginData.append(passwordField, password);  
  
if (csrfToken) {  
  loginData.append('_token', csrfToken);  
}  

console.log('2. Attempting login...');  
  
// Perform login  
const loginResponse = await session.post(PORTAL_URLS.login, loginData, {  
  headers: {  
    'Content-Type': 'application/x-www-form-urlencoded',  
    'Referer': PORTAL_URLS.login,  
    'Origin': JU_BASE_URL  
  },  
  maxRedirects: 5  
});  

console.log('   Login response status:', loginResponse.status);  
console.log('   Login response URL:', loginResponse.config.url);  

// Check if login was successful  
const $postLogin = cheerio.load(loginResponse.data);  
const postLoginTitle = $postLogin('title').text();  
console.log('   After login title:', postLoginTitle);  

// Check for common success indicators  
const hasLogout = $postLogin('a[href*="logout"], button[href*="logout"]').length > 0;  
const hasDashboard = $postLogin('a[href*="dashboard"], .dashboard').length > 0;  
const hasStudentMenu = $postLogin('a[href*="student"]').length > 0;  
  
console.log('   Has logout link:', hasLogout);  
console.log('   Has dashboard:', hasDashboard);  
console.log('   Has student menu:', hasStudentMenu);  

if (!hasLogout && !hasDashboard) {  
  // Check for login errors  
  const errorText = $postLogin('.alert-danger, .error, .text-danger').text().trim();  
  if (errorText) {  
    console.log('   Login error:', errorText);  
    return {  
      success: false,  
      error: `Login failed: ${errorText.substring(0, 100)}`  
    };  
  }  
    
  // If we can't determine success, try to access grades page anyway  
  console.log('   Could not determine login status, trying grades page...');  
}  

console.log('3. Accessing grades page...');  
  
// Try to access grades page  
const gradesResponse = await session.get(PORTAL_URLS.grades);  
console.log('   Grades page status:', gradesResponse.status);  
  
const $grades = cheerio.load(gradesResponse.data);  
const gradesTitle = $grades('title').text();  
console.log('   Grades page title:', gradesTitle);  

// Parse grade data  
const gradeData = parseGradeData($grades, username);  
console.log('   Grade parsing result:', gradeData.success ? 'Success' : 'Failed');  
  
return gradeData;

} catch (error) {
console.log('=== ERROR DETAILS ===');
console.log('Error message:', error.message);
console.log('Error code:', error.code);

if (error.response) {  
  console.log('Response status:', error.response.status);  
  console.log('Response URL:', error.response.config?.url);  
}  

let errorMessage = 'Login failed. ';  
  
if (error.code === 'ECONNREFUSED') {  
  errorMessage += 'Cannot connect to university portal.';  
} else if (error.code === 'ETIMEDOUT') {  
  errorMessage += 'Connection timeout. Please try again.';  
} else if (error.response?.status === 401) {  
  errorMessage += 'Invalid username or password.';  
} else if (error.response?.status === 403) {  
  errorMessage += 'Access denied.';  
} else {  
  errorMessage += error.message;  
}  

return {  
  success: false,  
  error: errorMessage  
};

}
}

// Function to parse grade data (simplified)
function parseGradeData($, username) {
try {
const grades = [];
let studentInfo = {
name: 'Student',
id: username,
program: 'N/A'
};

// Try to find student name  
studentInfo.name = $('.student-name, .profile-name, .user-name, .name').first().text().trim() ||   
                  $('h1, h2').first().text().trim() ||  
                  'Student';  

// Look for grade tables  
$('table').each((i, table) => {  
  const $table = $(table);  
  const rows = $table.find('tr');  
    
  if (rows.length > 1) {  
    rows.each((j, row) => {  
      if (j > 0) { // Skip header  
        const cols = $(row).find('td');  
        if (cols.length >= 2) {  
          const courseCode = $(cols[0]).text().trim();  
          const courseName = $(cols[1]).text().trim();  
          const grade = $(cols[cols.length - 1]).text().trim();  
            
          if (courseCode && grade) {  
            grades.push({  
              code: courseCode,  
              name: courseName || 'Course',  
              credit: 'N/A',  
              grade: grade  
            });  
          }  
        }  
      }  
    });  
  }  
});  

// If no structured grades found, look for any grade-like text  
if (grades.length === 0) {  
  $('body').text().split('\n').forEach(line => {  
    const trimmed = line.trim();  
    const gradeMatch = trimmed.match(/([A-F][+-]?|[0-4]\.?[0-9]*)$/);  
    if (gradeMatch && trimmed.length < 100) {  
      grades.push({  
        code: `C${grades.length + 1}`,  
        name: 'Course',  
        credit: 'N/A',  
        grade: gradeMatch[1]  
      });  
    }  
  });  
}  

return {  
  success: true,  
  studentInfo: studentInfo,  
  grades: grades,  
  cgpa: 'Check portal',  
  summary: `Found ${grades.length} items`  
};

} catch (error) {
console.log('Parse error:', error);
return {
success: false,
error: 'Could not parse grade data'
};
}
}

// Format response
function formatGradeResponse(gradeData) {
if (!gradeData.success) {
return ❌ *Error*\n\n${gradeData.error};
}

let response = 🎓 *Jimma University*\n\n;
response += 👤 *Name:* ${gradeData.studentInfo.name}\n;
response += 🆔 *ID:* ${gradeData.studentInfo.id}\n\n;

if (gradeData.grades.length > 0) {
response += 📊 *Results:*\n\``\n`;

gradeData.grades.slice(0, 10).forEach(course => {  
  response += `${course.code}: ${course.grade}\n`;  
});  
  
if (gradeData.grades.length > 10) {  
  response += `... ${gradeData.grades.length - 10} more\n`;  
}  
  
response += `\`\`\`\n`;

} else {
response += ℹ️ No grade data found.\n;
response += You are logged in but no grades were detected.\n;
}

response += \n🔄 *Status:* ${gradeData.summary};

return response;
}

// Bot commands
bot.onText(//start/, (msg) => {
const chatId = msg.chat.id;
bot.sendMessage(chatId,
🤖 *JU Grade Bot*\n\n +
Use /login to check your grades.\n\n +
*Note:* This is a debug version.,
{ parse_mode: 'Markdown' }
);
});

bot.onText(//login/, (msg) => {
const chatId = msg.chat.id;
userSessions.set(chatId, { step: 'awaiting_username' });
bot.sendMessage(chatId, 'Enter your JU username:');
});

// Handle messages
bot.on('message', async (msg) => {
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
  console.log(`=== Starting login for user: ${userData.username} ===`);  
  const gradeData = await fetchJUGrades(userData.username, userData.password);  
    
  // Clear sensitive data  
  userData.password = null;  
  userSessions.delete(chatId);  
    
  const responseText = formatGradeResponse(gradeData);  
  bot.editMessageText(responseText, {  
    chat_id: chatId,  
    message_id: loadingMsg.message_id,  
    parse_mode: 'Markdown'  
  });  
    
} catch (error) {  
  console.error('Final error:', error);  
  bot.editMessageText('❌ Unexpected error. Check logs.', {  
    chat_id: chatId,  
    message_id: loadingMsg.message_id  
  });  
  userSessions.delete(chatId);  
}

}
});

// Vercel handler
module.exports = async (req, res) => {
if (process.env.VERCEL_URL && !process.env.WEBHOOK_SET) {
await setWebhook();
process.env.WEBHOOK_SET = 'true';
}

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
