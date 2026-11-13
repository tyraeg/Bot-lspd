const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, Events, PermissionFlagsBits, REST, Routes, SlashCommandBuilder, AttachmentBuilder, ActivityType, ChannelType, ModalBuilder, TextInputBuilder, TextInputStyle, InteractionType } = require('discord.js');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const initSqlJs = require('sql.js');
const fs = require('fs');
const express = require('express');
const https = require('https');

const TOKEN = process.env.TOKEN;
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL;

// ==========================================
// ID ADMIN BOT (Người sở hữu bot)
// ==========================================
const ADMIN_ID = '1498554147304247296'; 

// ==========================================
// ID ROLE BẮT BUỘC (Chỉ ai có Role này mới được On/Off Duty)
// ==========================================
const REQUIRED_ROLE_ID = '1568699055561904198'; 
// ==========================================

let config = { dutyChannelId: null, warningChannelId: null, leaveChannelId: null, boardChannelId: null };
function loadConfig() { if (fs.existsSync('config.json')) { try { config = JSON.parse(fs.readFileSync('config.json', 'utf8')); } catch (e) {} } }
function saveConfig() { fs.writeFileSync('config.json', JSON.stringify(config, null, 2)); }

let db;
let isDbReady = false;
let lastBoardUpdateTime = Date.now(); 

async function initDatabase() {
    try {
        const SQL = await initSqlJs();
        if (fs.existsSync('duty.db')) {
            try { db = new SQL.Database(fs.readFileSync('duty.db')); } 
            catch(e) { fs.unlinkSync('duty.db'); db = new SQL.Database(); }
        } else { db = new SQL.Database(); }
        
        db.run(`CREATE TABLE IF NOT EXISTS users (
            user_id TEXT PRIMARY KEY, is_on_duty INTEGER DEFAULT 0, start_time INTEGER DEFAULT 0,
            total_time INTEGER DEFAULT 0, total_days INTEGER DEFAULT 0, is_on_leave INTEGER DEFAULT 0,
            leave_date TEXT DEFAULT NULL, schedule_start TEXT DEFAULT NULL, schedule_end TEXT DEFAULT NULL,
            has_warned_schedule INTEGER DEFAULT 0, unit TEXT DEFAULT 'Chưa cập nhật', repeat_daily INTEGER DEFAULT 0, shift_name TEXT DEFAULT NULL
        )`);
        
        db.run(`CREATE TABLE IF NOT EXISTS blacklist (
            user_id TEXT PRIMARY KEY, reason TEXT, banned_by TEXT, date TEXT
        )`);
        
        try { db.run('ALTER TABLE users ADD COLUMN total_days INTEGER DEFAULT 0'); } catch (e) {}
        try { db.run('ALTER TABLE users ADD COLUMN is_on_leave INTEGER DEFAULT 0'); } catch (e) {}
        try { db.run('ALTER TABLE users ADD COLUMN leave_date TEXT DEFAULT NULL'); } catch (e) {}
        try { db.run('ALTER TABLE users ADD COLUMN schedule_start TEXT DEFAULT NULL'); } catch (e) {}
        try { db.run('ALTER TABLE users ADD COLUMN schedule_end TEXT DEFAULT NULL'); } catch (e) {}
        try { db.run('ALTER TABLE users ADD COLUMN has_warned_schedule INTEGER DEFAULT 0'); } catch (e) {}
        try { db.run('ALTER TABLE users ADD COLUMN unit TEXT DEFAULT "Chưa cập nhật"'); } catch (e) {}
        try { db.run('ALTER TABLE users ADD COLUMN repeat_daily INTEGER DEFAULT 0'); } catch (e) {}
        try { db.run('ALTER TABLE users ADD COLUMN shift_name TEXT DEFAULT NULL'); } catch (e) {}
        
        db.run(`CREATE TABLE IF NOT EXISTS history (user_id TEXT, date TEXT, PRIMARY KEY (user_id, date))`);
        
        db.run(`CREATE TABLE IF NOT EXISTS weekly_history (
            user_id TEXT, week_id TEXT, week_time INTEGER DEFAULT 0,
            PRIMARY KEY (user_id, week_id)
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS monthly_history (
            user_id TEXT, month_id TEXT, month_time INTEGER DEFAULT 0,
            PRIMARY KEY (user_id, month_id)
        )`);
        
        saveDatabase(); isDbReady = true;
        console.log("✅ Database đã sẵn sàng!");
    } catch (error) { console.error("❌ LỖI DATABASE:", error); }
}

function saveDatabase() { if (db) { try { fs.writeFileSync('duty.db', Buffer.from(db.export())); } catch (e) {} } }

function isBlacklisted(userId) {
    if (!isDbReady) return false;
    const stmt = db.prepare('SELECT * FROM blacklist WHERE user_id = ?');
    stmt.bind([userId]);
    const exists = stmt.step();
    stmt.free();
    return exists;
}

function getWeekId() {
    try {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        d.setDate(d.getDate() + 3 - (d.getDay() + 6) % 7);
        const week1 = new Date(d.getFullYear(), 0, 4);
        const weekNum = 1 + Math.round(((d.getTime() - week1.getTime()) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
        return `${d.getFullYear()}-W${weekNum}`;
    } catch (e) { return "UNKNOWN-WEEK"; }
}

function getMonthId() {
    const d = new Date();
    return `${d.getFullYear()}-M${d.getMonth() + 1}`;
}

function checkLeaveStatus(user) {
    if (user.is_on_leave === 1 && user.leave_date) {
        const today = new Date().toISOString().split('T')[0];
        if (today > user.leave_date) {
            db.run('UPDATE users SET is_on_leave = 0, leave_date = NULL WHERE user_id = ?', [user.user_id]);
            saveDatabase();
            user.is_on_leave = 0;
        }
    }
    return user;
}

function checkAndAddDay(userId) {
    if (!isDbReady) return;
    try {
        const today = new Date().toISOString().split('T')[0];
        const stmt = db.prepare('SELECT * FROM history WHERE user_id = ? AND date = ?');
        stmt.bind([userId, today]);
        if (!stmt.step()) { db.run('INSERT INTO history (user_id, date) VALUES (?, ?)', [userId, today]); db.run('UPDATE users SET total_days = total_days + 1 WHERE user_id = ?', [userId]); saveDatabase(); }
        stmt.free();
    } catch (e) { console.log("Lỗi checkAndAddDay:", e); }
}

const getOrCreateUser = (userId) => {
    if (!isDbReady) return { user_id: userId, is_on_duty: 0, start_time: 0, total_time: 0, total_days: 0, is_on_leave: 0, leave_date: null, unit: 'Chưa cập nhật', repeat_daily: 0, shift_name: null };
    const stmt = db.prepare('SELECT * FROM users WHERE user_id = ?'); stmt.bind([userId]);
    let user = null; if (stmt.step()) user = stmt.getAsObject(); stmt.free();
    if (!user) { db.run('INSERT INTO users (user_id) VALUES (?)', [userId]); saveDatabase(); user = { user_id: userId, is_on_duty: 0, start_time: 0, total_time: 0, total_days: 0, is_on_leave: 0, leave_date: null, unit: 'Chưa cập nhật', repeat_daily: 0, shift_name: null }; } else { user = checkLeaveStatus(user); }
    return user;
};
const formatTime = (ms) => {
    if (!ms || ms < 1000) return "0s";
    const totalSeconds = Math.floor(ms / 1000);
    if (totalSeconds < 60) return `${totalSeconds}s`;
    const totalMinutes = Math.floor(totalSeconds / 60);
    if (totalMinutes < 60) return `${totalMinutes}m`;
    return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
};
const timeToMinutes = (timeStr) => { const [h, m] = timeStr.split(':').map(Number); return h * 60 + m; };
const getVNTime = () => new Date().toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" });

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMembers, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages] });

const commands = [
    new SlashCommandBuilder().setName('setlich').setDescription('Cài đặt lịch trực')
        .addUserOption(opt => opt.setName('user').setDescription('Chọn nhân viên').setRequired(true))
        .addStringOption(opt => opt.setName('ca').setDescription('Chọn tên Ca (VD: Sáng, Trưa, Chiều, Tối)').setRequired(true))
        .addStringOption(opt => opt.setName('start').setDescription('Giờ bắt đầu (VD: 07:30)').setRequired(true))
        .addStringOption(opt => opt.setName('end').setDescription('Giờ kết thúc (VD: 11:45)').setRequired(true))
        .addBooleanOption(opt => opt.setName('lap').setDescription('Lặp lại hàng ngày? (True = Có, False = Chỉ hôm nay)').setRequired(true)),
    new SlashCommandBuilder().setName('xemca').setDescription('Xem lịch trực của tất cả nhân viên (Dạng ảnh)'),
    new SlashCommandBuilder().setName('setupduty').setDescription('Đặt kênh Log On/Off'),
    new SlashCommandBuilder().setName('setupwarning').setDescription('Đặt kênh Cảnh báo'),
    new SlashCommandBuilder().setName('setupleave').setDescription('Đặt kênh Nghỉ phép'),
    new SlashCommandBuilder().setName('resetuser').setDescription('Reset dữ liệu 1 người').addUserOption(opt => opt.setName('user').setDescription('Chọn nhân viên').setRequired(true)),
    new SlashCommandBuilder().setName('resetdata').setDescription('Xóa sạch toàn bộ dữ liệu'),
    new SlashCommandBuilder().setName('resetnghi').setDescription('Gỡ trạng thái nghỉ phép cho nhân viên').addUserOption(opt => opt.setName('user').setDescription('Chọn nhân viên').setRequired(true)),
    new SlashCommandBuilder().setName('export').setDescription('Xuất file sao lưu (Cấu hình + Dữ liệu)'),
    new SlashCommandBuilder().setName('import').setDescription('Nhập file sao lưu').addAttachmentOption(opt => opt.setName('file').setDescription('File json').setRequired(true)),
    new SlashCommandBuilder().setName('setstatus').setDescription('Đổi trạng thái của Bot')
        .addStringOption(opt => opt.setName('presence').setDescription('Trạng thái hoạt động').setRequired(true).addChoices(
            { name: 'Online (Trực tuyến)', value: 'online' },
            { name: 'Idle (Treo máy)', value: 'idle' },
            { name: 'Do Not Disturb (Không làm phiền)', value: 'dnd' },
            { name: 'Invisible (Ẩn)', value: 'invisible' }
        ))
        .addStringOption(opt => opt.setName('type').setDescription('Loại hoạt động').setRequired(true).addChoices(
            { name: 'Đang Chơi (Playing)', value: 'PLAYING' },
            { name: 'Đang Xem (Watching)', value: 'WATCHING' },
            { name: 'Đang Nghe (Listening)', value: 'LISTENING' }
        ))
        .addStringOption(opt => opt.setName('text').setDescription('Nội dung trạng thái').setRequired(true)),
    new SlashCommandBuilder().setName('chat').setDescription('Gửi tin nhắn/ảnh thay mặt bot')
        .addChannelOption(opt => opt.setName('channel').setDescription('Chọn kênh muốn gửi').addChannelTypes(ChannelType.GuildText).setRequired(true))
        .addStringOption(opt => opt.setName('message').setDescription('Nội dung tin nhắn (Có thể bỏ trống nếu chỉ gửi ảnh)').setRequired(false))
        .addAttachmentOption(opt => opt.setName('image').setDescription('Đính kèm ảnh/file (Không bắt buộc)').setRequired(false)),
    new SlashCommandBuilder().setName('blacklist').setDescription('Đưa một nhân viên vào danh sách đen (Cấm On Duty)')
        .addUserOption(opt => opt.setName('user').setDescription('Chọn người bị phạt').setRequired(true))
        .addStringOption(opt => opt.setName('reason').setDescription('Lý do vi phạm').setRequired(true))
        .addChannelOption(opt => opt.setName('channel').setDescription('Kênh muốn gửi thông báo (Bỏ trống sẽ gửi vào kênh Cảnh báo)').addChannelTypes(ChannelType.GuildText).setRequired(false)),
    new SlashCommandBuilder().setName('setdonvi').setDescription('Cài đặt đơn vị (Unit) cho nhân viên')
        .addUserOption(opt => opt.setName('user').setDescription('Chọn nhân viên').setRequired(true))
        .addStringOption(opt => opt.setName('unit').setDescription('Tên đơn vị (VD: Traffic, SWAT, K9...)').setRequired(true)),
    new SlashCommandBuilder().setName('hoso').setDescription('Xem hồ sơ nhân sự (Dạng ảnh)')
        .addUserOption(opt => opt.setName('user').setDescription('Chọn người muốn xem').setRequired(true)),
    new SlashCommandBuilder().setName('bxhtuan').setDescription('Xem bảng xếp hạng theo tuần'),
    new SlashCommandBuilder().setName('bxhthang').setDescription('Xem bảng xếp hạng theo tháng')
].map(command => command.toJSON());

client.once(Events.ClientReady, async () => {
    console.log(`🚀 BOT ĐÃ ONLINE: ${client.user.tag}`);
    
    client.user.setPresence({
        status: 'online',
        activities: [{ name: 'LSPD - GTANetWork', type: ActivityType.Watching }]
    });

    loadConfig(); initDatabase();
    try { const rest = new REST({ version: '10' }).setToken(TOKEN); await rest.put(Routes.applicationCommands(client.user.id), { body: commands }); console.log('✅ Đã đăng ký lệnh Slash!'); } catch (error) { console.error('❌ Lỗi đăng ký lệnh:', error); }
});

// ==========================================
// CÁC HÀM VẼ ẢNH (CANVAS)
// ==========================================

// 1. Vẽ Bảng Chấm Công
async function generateBoardImage(guild) {
    const stmt = db.prepare('SELECT * FROM users'); const users = []; while (stmt.step()) users.push(stmt.getAsObject()); stmt.free();
    const activeUsers = users.filter(u => u.total_time > 0 || u.is_on_duty === 1 || u.is_on_leave === 1);
    
    const rowHeight = 65, headerHeight = 130, padding = 20, width = 800;
    const height = headerHeight + (activeUsers.length * rowHeight) + padding;
    
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#1e1f22'; ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#2b2d31'; ctx.fillRect(0, 0, width, 85);
    ctx.fillStyle = '#ffffff'; ctx.font = 'bold 32px sans-serif'; ctx.fillText('Danh Sách Nhân Sự LSPD GTANetWork', padding, 50);
    ctx.font = '16px sans-serif'; ctx.fillStyle = '#b5bac1'; ctx.fillText(`Cập nhật: ${getVNTime()}`, padding, 75);

    ctx.fillStyle = '#1e1f22'; ctx.fillRect(0, 85, width, 45);
    ctx.fillStyle = '#f2f3f5'; ctx.font = 'bold 18px sans-serif';
    ctx.fillText('TÊN NHÂN VIÊN', 90, 115); 
    ctx.fillText('TRẠNG THÁI', 450, 115); 
    ctx.fillText('TỔNG THỜI GIAN', 630, 115);

    let y = headerHeight;
    for (let i = 0; i < activeUsers.length; i++) {
        let u = checkLeaveStatus(activeUsers[i]);
        const member = await guild.members.fetch(u.user_id).catch(() => null);
        const name = member ? member.displayName : "Unknown";
        
        if (i % 2 === 0) { ctx.fillStyle = '#232428'; ctx.fillRect(0, y, width, rowHeight); }
        try {
            const avatarURL = member ? member.user.displayAvatarURL({ extension: 'png', size: 64 }) : null;
            if (avatarURL) {
                const avatar = await loadImage(avatarURL);
                ctx.save(); ctx.beginPath(); ctx.arc(padding + 25, y + 32, 22, 0, Math.PI * 2, true); ctx.closePath(); ctx.clip();
                ctx.drawImage(avatar, padding + 3, y + 10, 44, 44); ctx.restore();
            }
        } catch (e) {}

        ctx.fillStyle = '#ffffff'; ctx.font = 'bold 20px sans-serif'; ctx.fillText(name.substring(0, 20), 90, y + 40);

        let statusText = "OFFLINE", statusColor = "#ed4245";
        if (u.is_on_leave) { statusText = "ON LEAVE"; statusColor = "#fee75c"; }
        else if (u.is_on_duty) { statusText = "ON DUTY"; statusColor = "#57f287"; }
        ctx.fillStyle = statusColor; ctx.font = 'bold 18px sans-serif'; ctx.fillText(statusText, 450, y + 40);

        let time = u.total_time; if (u.is_on_duty) time += (Date.now() - u.start_time);
        ctx.fillStyle = '#dbdee1'; ctx.font = '20px sans-serif'; ctx.fillText(formatTime(time), 630, y + 40);
        y += rowHeight;
    }
    return canvas.toBuffer('image/png');
}

// 2. Vẽ Bảng Xếp Hạng (BXH Tổng)
async function generateBXHImage(guild) {
    const stmt = db.prepare('SELECT * FROM users ORDER BY total_time DESC LIMIT 10'); const users = []; while (stmt.step()) users.push(stmt.getAsObject()); stmt.free();
    if (users.length === 0) return null;

    let totalOnline = 0;
    for (const u of users) { if (u.total_time > 0 || u.is_on_duty === 1) totalOnline++; }

    const rowHeight = 70, headerHeight = 150, padding = 20, width = 850;
    const height = headerHeight + (users.length * rowHeight) + padding;
    
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#1e1f22'; ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#2b2d31'; ctx.fillRect(0, 0, width, 100);
    ctx.fillStyle = '#FFD700'; ctx.font = 'bold 34px sans-serif'; ctx.fillText('Bảng Xếp Hạng Tổng LSPD - GTANetWork', padding, 50);
    ctx.fillStyle = '#b5bac1'; ctx.font = '16px sans-serif'; ctx.fillText(`Tổng số nhân sự từng Online: ${totalOnline} người.`, padding, 80);

    ctx.fillStyle = '#1e1f22'; ctx.fillRect(0, 100, width, 50);
    ctx.fillStyle = '#f2f3f5'; ctx.font = 'bold 18px sans-serif';
    ctx.fillText('HẠNG', 20, 132);
    ctx.fillText('TÊN NHÂN VIÊN', 100, 132);
    ctx.fillText('TRẠNG THÁI', 450, 132);
    ctx.fillText('TỔNG THỜI GIAN', 630, 132);

    let y = headerHeight;
    for (let i = 0; i < users.length; i++) {
        let u = users[i];
        const member = await guild.members.fetch(u.user_id).catch(() => null);
        const name = member ? member.displayName : "Unknown";
        
        if (i % 2 === 0) { ctx.fillStyle = '#232428'; ctx.fillRect(0, y, width, rowHeight); }

        ctx.fillStyle = i === 0 ? '#FFD700' : i === 1 ? '#C0C0C0' : i === 2 ? '#CD7F32' : '#ffffff'; 
        ctx.font = 'bold 24px sans-serif'; ctx.fillText(`#${i + 1}`, 25, y + 45);

        try {
            const avatarURL = member ? member.user.displayAvatarURL({ extension: 'png', size: 64 }) : null;
            if (avatarURL) {
                const avatar = await loadImage(avatarURL);
                ctx.save(); ctx.beginPath(); ctx.arc(padding + 90, y + 35, 20, 0, Math.PI * 2, true); ctx.closePath(); ctx.clip();
                ctx.drawImage(avatar, padding + 70, y + 15, 40, 40); ctx.restore();
            }
        } catch (e) {}
        
        ctx.fillStyle = '#ffffff'; ctx.font = 'bold 20px sans-serif'; ctx.fillText(name.substring(0, 18), 130, y + 42);

        let statusText = "OFFLINE", statusColor = "#ed4245"; 
        if (u.is_on_leave) { statusText = "ON LEAVE"; statusColor = "#fee75c"; } 
        else if (u.is_on_duty) { statusText = "ON DUTY"; statusColor = "#57f287"; } 
        ctx.fillStyle = statusColor; ctx.font = 'bold 18px sans-serif'; ctx.fillText(statusText, 450, y + 42);

        let time = u.total_time; if (u.is_on_duty) time += (Date.now() - u.start_time);
        ctx.fillStyle = '#dbdee1'; ctx.font = 'bold 20px sans-serif'; ctx.fillText(formatTime(time), 630, y + 42);
        y += rowHeight;
    }
    return canvas.toBuffer('image/png');
}

// 3. Vẽ Bảng Xếp Hạng Tuần/Tháng
async function generateTimeBXHImage(guild, type = 'week') {
    const currentId = type === 'week' ? getWeekId() : getMonthId();
    const table = type === 'week' ? 'weekly_history' : 'monthly_history';
    const colName = type === 'week' ? 'week_time' : 'month_time';
    
    const query = `
        SELECT u.user_id, COALESCE(w.${colName}, 0) as calc_time, u.is_on_duty, u.start_time, u.is_on_leave, u.total_time 
        FROM users u 
        LEFT JOIN ${table} w ON u.user_id = w.user_id AND ${type === 'week' ? 'w.week_id' : 'w.month_id'} = ?
        WHERE COALESCE(w.${colName}, 0) > 0 OR u.is_on_duty = 1
        ORDER BY calc_time DESC LIMIT 10
    `;
    const stmt = db.prepare(query);
    stmt.bind([currentId]);
    const users = []; while (stmt.step()) users.push(stmt.getAsObject()); stmt.free();
    
    if (users.length === 0) return null;

    const titleText = type === 'week' ? 'Bảng Xếp Hạng LSPD Tuần Này' : 'Bảng Xếp Hạng LSPD Tháng Này';
    const rowHeight = 70, headerHeight = 150, padding = 20, width = 850;
    const height = headerHeight + (users.length * rowHeight) + padding;
    
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#1e1f22'; ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#2b2d31'; ctx.fillRect(0, 0, width, 100);
    ctx.fillStyle = '#00BFFF'; ctx.font = 'bold 34px sans-serif'; ctx.fillText(titleText, padding, 50);
    ctx.fillStyle = '#b5bac1'; ctx.font = '16px sans-serif'; ctx.fillText(`Tính từ: ${type === 'week' ? getWeekId() : getMonthId()}`, padding, 80);

    ctx.fillStyle = '#1e1f22'; ctx.fillRect(0, 100, width, 50);
    ctx.fillStyle = '#f2f3f5'; ctx.font = 'bold 18px sans-serif';
    ctx.fillText('HẠNG', 20, 132);
    ctx.fillText('TÊN NHÂN VIÊN', 100, 132);
    ctx.fillText('TRẠNG THÁI', 450, 132);
    ctx.fillText('THỜI GIAN', 630, 132);

    let y = headerHeight;
    for (let i = 0; i < users.length; i++) {
        let u = users[i];
        const member = await guild.members.fetch(u.user_id).catch(() => null);
        const name = member ? member.displayName : "Unknown";
        
        if (i % 2 === 0) { ctx.fillStyle = '#232428'; ctx.fillRect(0, y, width, rowHeight); }

        ctx.fillStyle = i === 0 ? '#FFD700' : i === 1 ? '#C0C0C0' : i === 2 ? '#CD7F32' : '#ffffff'; 
        ctx.font = 'bold 24px sans-serif'; ctx.fillText(`#${i + 1}`, 25, y + 45);

        try {
            const avatarURL = member ? member.user.displayAvatarURL({ extension: 'png', size: 64 }) : null;
            if (avatarURL) {
                const avatar = await loadImage(avatarURL);
                ctx.save(); ctx.beginPath(); ctx.arc(padding + 90, y + 35, 20, 0, Math.PI * 2, true); ctx.closePath(); ctx.clip();
                ctx.drawImage(avatar, padding + 70, y + 15, 40, 40); ctx.restore();
            }
        } catch (e) {}
        
        ctx.fillStyle = '#ffffff'; ctx.font = 'bold 20px sans-serif'; ctx.fillText(name.substring(0, 18), 130, y + 42);

        let statusText = "OFFLINE", statusColor = "#ed4245"; 
        if (u.is_on_leave) { statusText = "ON LEAVE"; statusColor = "#fee75c"; } 
        else if (u.is_on_duty) { statusText = "ON DUTY"; statusColor = "#57f287"; } 
        ctx.fillStyle = statusColor; ctx.font = 'bold 18px sans-serif'; ctx.fillText(statusText, 450, y + 42);

        let time = u.calc_time; if (u.is_on_duty) time += (Date.now() - u.start_time);
        ctx.fillStyle = '#00BFFF'; ctx.font = 'bold 20px sans-serif'; ctx.fillText(formatTime(time), 630, y + 42);
        y += rowHeight;
    }
    return canvas.toBuffer('image/png');
}

// 4. Vẽ Hồ Sơ Nhân Sự
async function generateProfileImage(targetUser, member) {
    const currentWeek = getWeekId();
    const currentMonth = getMonthId();

    const stmt = db.prepare(`
        SELECT u.*, COALESCE(w.week_time, 0) as week_time, COALESCE(m.month_time, 0) as month_time 
        FROM users u 
        LEFT JOIN weekly_history w ON u.user_id = w.user_id AND w.week_id = ?
        LEFT JOIN monthly_history m ON u.user_id = m.user_id AND m.month_id = ?
        WHERE u.user_id = ?
    `);
    stmt.bind([currentWeek, currentMonth, targetUser.id]);
    let u = null; if (stmt.step()) u = stmt.getAsObject(); stmt.free();
    
    if (!u) u = { user_id: targetUser.id, is_on_duty: 0, start_time: 0, total_time: 0, total_days: 0, is_on_leave: 0, week_time: 0, month_time: 0, unit: 'Chưa cập nhật' };
    u = checkLeaveStatus(u);

    let highestRole = "Chưa có";
    if (member && member.roles.cache.size > 1) {
        const roles = member.roles.cache.filter(r => r.id !== member.guild.id).sort((a, b) => b.position - a.position);
        if (roles.size > 0) highestRole = roles.first().name;
    }

    const width = 800, height = 450, padding = 30;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#1e1f22'; ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#2b2d31'; ctx.fillRect(0, 0, width, 80);
    ctx.fillStyle = '#ffffff'; ctx.font = 'bold 28px sans-serif'; ctx.fillText('Hồ Sơ Sĩ Quan LSPD', padding, 50);
    
    try {
        const avatarURL = targetUser.displayAvatarURL({ extension: 'png', size: 256 });
        const avatar = await loadImage(avatarURL);
        ctx.save();
        ctx.beginPath();
        ctx.arc(150, 250, 80, 0, Math.PI * 2, true);
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(avatar, 70, 170, 160, 160);
        ctx.restore();
        ctx.strokeStyle = '#00BFFF'; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(150, 250, 80, 0, Math.PI * 2, true); ctx.stroke();
    } catch (e) {}

    ctx.fillStyle = '#ffffff'; ctx.font = 'bold 36px sans-serif'; 
    ctx.fillText(member ? member.displayName : targetUser.username, 260, 180);

    ctx.fillStyle = '#b5bac1'; ctx.font = '20px sans-serif';
    ctx.fillText(`Cấp bậc:`, 260, 230);
    ctx.fillStyle = '#FFD700'; ctx.font = 'bold 20px sans-serif';
    ctx.fillText(highestRole, 370, 230);

    ctx.fillStyle = '#b5bac1'; ctx.font = '20px sans-serif';
    ctx.fillText(`Đơn vị:`, 260, 270);
    ctx.fillStyle = '#00BFFF'; ctx.font = 'bold 20px sans-serif';
    ctx.fillText(u.unit, 340, 270);

    ctx.fillStyle = '#b5bac1'; ctx.font = '20px sans-serif';
    ctx.fillText(`Trạng thái:`, 260, 310);
    let statusText = "OFFLINE", statusColor = "#ed4245";
    if (u.is_on_leave) { statusText = "ON LEAVE"; statusColor = "#fee75c"; }
    else if (u.is_on_duty) { statusText = "ON DUTY"; statusColor = "#57f287"; }
    ctx.fillStyle = statusColor; ctx.font = 'bold 20px sans-serif';
    ctx.fillText(statusText, 370, 310);

    ctx.strokeStyle = '#333336'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(padding, 350); ctx.lineTo(width - padding, 350); ctx.stroke();

    ctx.fillStyle = '#f2f3f5'; ctx.font = 'bold 22px sans-serif';
    const timeTotal = u.total_time + (u.is_on_duty ? (Date.now() - u.start_time) : 0);
    const timeWeek = u.week_time + (u.is_on_duty ? (Date.now() - u.start_time) : 0);
    const timeMonth = u.month_time + (u.is_on_duty ? (Date.now() - u.start_time) : 0);

    ctx.fillText(`Tổng Thời Gian Trực: ${formatTime(timeTotal)}`, padding, 400);
    ctx.fillText(`Ngày Làm: ${u.total_days} ngày`, 400, 400);

    ctx.fillStyle = '#b5bac1'; ctx.font = '18px sans-serif';
    ctx.fillText(`Tuần này: ${formatTime(timeWeek)}  |  Tháng này: ${formatTime(timeMonth)}`, padding, 435);

    return canvas.toBuffer('image/png');
}

// 5. Vẽ Bảng Lịch Trực Tất Cả Mọi Người
async function generateAllSchedulesImage(guild) {
    const stmt = db.prepare('SELECT * FROM users WHERE schedule_start IS NOT NULL'); 
    const users = []; while (stmt.step()) users.push(stmt.getAsObject()); stmt.free();
    
    if (users.length === 0) return null;

    const rowHeight = 60, headerHeight = 150, padding = 20, width = 900;
    const height = headerHeight + (users.length * rowHeight) + padding;
    
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#1e1f22'; ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#2b2d31'; ctx.fillRect(0, 0, width, 90);
    ctx.fillStyle = '#ffffff'; ctx.font = 'bold 28px sans-serif'; 
    ctx.fillText('LỊCH TRỰC TOÀN BỘ NHÂN SỰ', padding, 45);
    ctx.font = '16px sans-serif'; ctx.fillStyle = '#b5bac1'; 
    ctx.fillText(`Cập nhật: ${getVNTime()}`, padding, 75);

    ctx.fillStyle = '#1e1f22'; ctx.fillRect(0, 90, width, 60);
    ctx.fillStyle = '#f2f3f5'; ctx.font = 'bold 18px sans-serif';
    
    ctx.fillText('TÊN NHÂN VIÊN', 30, 125); 
    ctx.fillText('TÊN CA', 320, 125);
    ctx.fillText('GIỜ BẮT ĐẦU', 450, 125); 
    ctx.fillText('GIỜ KẾT THÚC', 600, 125);
    ctx.fillText('LẶP LẠI', 760, 125);

    let y = headerHeight;
    for (let i = 0; i < users.length; i++) {
        let u = users[i];
        const member = await guild.members.fetch(u.user_id).catch(() => null);
        const name = member ? member.displayName : "Unknown";
        
        if (i % 2 === 0) { ctx.fillStyle = '#232428'; ctx.fillRect(0, y, width, rowHeight); }

        ctx.fillStyle = '#ffffff'; ctx.font = 'bold 18px sans-serif'; 
        ctx.fillText(name.substring(0, 20), 30, y + 38);

        ctx.fillStyle = '#FFD700'; ctx.font = 'bold 18px sans-serif'; 
        ctx.fillText(u.shift_name || 'Tùy chỉnh', 320, y + 38);

        ctx.fillStyle = '#00BFFF'; ctx.font = 'bold 18px sans-serif'; 
        ctx.fillText(u.schedule_start, 450, y + 38);

        ctx.fillStyle = '#FFA500'; ctx.font = 'bold 18px sans-serif'; 
        ctx.fillText(u.schedule_end, 600, y + 38);

        ctx.fillStyle = u.repeat_daily === 1 ? '#57f287' : '#ed4245'; 
        ctx.font = 'bold 18px sans-serif'; 
        ctx.fillText(u.repeat_daily === 1 ? 'Hàng ngày' : 'Hôm nay', 760, y + 38);

        y += rowHeight;
    }
    return canvas.toBuffer('image/png');
}

// 6. Vẽ Bảng Thống Kê (Stats) - ĐÃ KHÔI PHỤC
async function generateStatsImage(guild) {
    const currentWeek = getWeekId();
    const query = `
        SELECT u.*, COALESCE(w.week_time, 0) as week_time 
        FROM users u 
        LEFT JOIN weekly_history w ON u.user_id = w.user_id AND w.week_id = ?
        ORDER BY u.total_time DESC
    `;
    const stmt = db.prepare(query);
    stmt.bind([currentWeek]);
    const users = []; 
    while (stmt.step()) users.push(stmt.getAsObject()); 
    stmt.free();
    
    const activeUsers = users.filter(u => u.total_time > 0 || u.is_on_duty === 1 || u.week_time > 0);
    if (activeUsers.length === 0) return null;

    let tM = 0, tD = 0, tT = 0, oC = 0;
    for (const u of activeUsers) {
        tM++; tD += u.total_days;
        if (u.is_on_duty) { oC++; tT += (u.total_time + (Date.now() - u.start_time)); } 
        else { tT += u.total_time; }
    }

    const rowHeight = 65, headerHeight = 280, padding = 20, width = 850;
    const height = headerHeight + (activeUsers.length * rowHeight) + padding;
    
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#1e1f22'; ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#2b2d31'; ctx.fillRect(0, 0, width, 120);
    ctx.fillStyle = '#00BFFF'; ctx.font = 'bold 34px sans-serif'; ctx.fillText('THỐNG KÊ LSPD GtaNetWork', padding, 55);
    ctx.fillStyle = '#ffffff'; ctx.font = 'bold 20px sans-serif'; 
    ctx.fillText(`Tổng nhân sự: ${tM}   |   Đang Online: ${oC}`, padding, 90);
    
    ctx.fillStyle = '#1e1f22'; ctx.fillRect(0, 130, width, 100);
    ctx.fillStyle = '#f2f3f5'; ctx.font = 'bold 20px sans-serif';
    ctx.fillText('Tổng ngày trực:', padding, 165); 
    ctx.fillStyle = '#dbdee1'; ctx.fillText(`${tD} ngày`, 250, 165);
    
    ctx.fillStyle = '#f2f3f5'; ctx.font = 'bold 20px sans-serif'; 
    ctx.fillText('Tổng thời gian:', padding, 200); 
    ctx.fillStyle = '#dbdee1'; ctx.fillText(`${formatTime(tT)}`, 250, 200);

    ctx.fillStyle = '#2b2d31'; ctx.fillRect(0, 230, width, 50);
    ctx.fillStyle = '#f2f3f5'; ctx.font = 'bold 18px sans-serif';
    ctx.fillText('TÊN NHÂN VIÊN', 80, 262);
    ctx.fillText('TRẠNG THÁI', 380, 262);
    ctx.fillText('TUẦN NÀY', 530, 262);
    ctx.fillText('TỔNG CỘNG', 680, 262);

    let y = headerHeight;
    for (let i = 0; i < activeUsers.length; i++) {
        let u = checkLeaveStatus(activeUsers[i]);
        const member = await guild.members.fetch(u.user_id).catch(() => null);
        const name = member ? member.displayName : "Unknown";
        
        if (i % 2 === 0) { ctx.fillStyle = '#232428'; ctx.fillRect(0, y, width, rowHeight); }

        ctx.fillStyle = '#ffffff'; ctx.font = 'bold 18px sans-serif'; ctx.fillText(name.substring(0, 18), 80, y + 40);

        let statusText = "OFFLINE", statusColor = "#ed4245";
        if (u.is_on_leave) { statusText = "ON LEAVE"; statusColor = "#fee75c"; }
        else if (u.is_on_duty) { statusText = "ON DUTY"; statusColor = "#57f287"; }
        ctx.fillStyle = statusColor; ctx.font = 'bold 16px sans-serif'; ctx.fillText(statusText, 380, y + 40);

        let weekTime = u.week_time;
        if (u.is_on_duty) weekTime += (Date.now() - u.start_time);
        ctx.fillStyle = '#00BFFF'; ctx.font = 'bold 18px sans-serif'; ctx.fillText(formatTime(weekTime), 530, y + 40);

        let totalTime = u.total_time; 
        if (u.is_on_duty) totalTime += (Date.now() - u.start_time);
        ctx.fillStyle = '#dbdee1'; ctx.font = 'bold 18px sans-serif'; ctx.fillText(formatTime(totalTime), 680, y + 40);
        
        y += rowHeight;
    }
    return canvas.toBuffer('image/png');
}

// ==========================================
// CẬP NHẬT BẢNG VÀ LỆNH
// ==========================================
async function updateDutyBoard(channel) {
    if (!isDbReady) return;
    try {
        let buffer = null;
        try { buffer = await generateBoardImage(channel.guild); } catch (err) { console.error("Lỗi vẽ bảng:", err); }
        
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('onduty_btn')
                .setLabel('On Duty')
                .setStyle(ButtonStyle.Success)
                .setEmoji('1570176137722724435'), 
            new ButtonBuilder()
                .setCustomId('offduty_btn')
                .setLabel('Off Duty')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('1570176005883306068'), 
            new ButtonBuilder()
                .setCustomId('leave_btn')
                .setLabel('Xin Nghỉ')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('1570177567434997820') 
        );

        const msgs = await channel.messages.fetch({ limit: 50 }); 
        const botMessages = msgs.filter(m => m.author.id === client.user.id);
        for (const m of botMessages.values()) { await m.delete().catch(() => {}); }

        const now = Date.now();
        const diffMinutes = Math.floor((now - lastBoardUpdateTime) / 60000);
        let timeText = diffMinutes < 1 ? `**Danh Sách Nhân Sự LSPD ON|OFF DUTY Cập Nhật: Vừa Xong**` : `**Danh Sách Nhân Sự LSPD ON|OFF DUTY Cập Nhật: ${diffMinutes} Phút Trước**`;
        lastBoardUpdateTime = now;

        if (buffer) {
            const attachment = new AttachmentBuilder(buffer, { name: 'dutylist.png' });
            await channel.send({ content: timeText, files: [attachment], components: [row] });
        } else {
            const stmt = db.prepare('SELECT * FROM users'); const users = []; while (stmt.step()) users.push(stmt.getAsObject()); stmt.free();
            let desc = "```\nMEMBER            STATUS     TOTAL TIME\n---------------------------------------\n";
            for (let u of users) {
                u = checkLeaveStatus(u); const m = await channel.guild.members.fetch(u.user_id).catch(() => null); if (!m) continue;
                let st = u.is_on_leave ? "ON LEAVE" : (u.is_on_duty ? "ON DUTY " : "OFFLINE ");
                let tm = formatTime(u.total_time); if (u.is_on_duty) tm = formatTime(u.total_time + (Date.now() - u.start_time)) + " (Live)";
                desc += `${m.displayName.padEnd(18).substring(0, 18)} ${st} ${tm}\n`;
            }
            desc += "```";
            const embed = new EmbedBuilder().setTitle("Danh Sách LSPD GTANetWork").setDescription(desc).setColor(0x2b2d31);
            await channel.send({ content: timeText, embeds: [embed], components: [row] });
        }
    } catch (e) { console.error(e); }
}

client.on(Events.InteractionCreate, async interaction => {
    if (interaction.isChatInputCommand()) {
        if (!isDbReady) return interaction.reply({ content: "Đang khởi động!", ephemeral: true });
        
        const isBotAdmin = interaction.user.id === ADMIN_ID;
        const isServerAdmin = interaction.member.permissions.has(PermissionFlagsBits.Administrator);

        if (!isBotAdmin && !isServerAdmin) {
            return interaction.reply({ content: "❌ Chỉ Cấp Cao mới có quyền sử dụng lệnh này!", ephemeral: true });
        }

        const { commandName, options, channel, guild } = interaction;

        if (commandName === 'setlich') {
            const targetUser = options.getUser('user'); 
            const shiftName = options.getString('ca');
            const startTime = options.getString('start'); 
            const endTime = options.getString('end');
            const isRepeat = options.getBoolean('lap');

            if (!startTime.includes(':') || !endTime.includes(':')) return interaction.reply({ content: "Giờ phải dạng HH:MM!", ephemeral: true });
            getOrCreateUser(targetUser.id);
            
            db.run('UPDATE users SET schedule_start = ?, schedule_end = ?, shift_name = ?, repeat_daily = ?, has_warned_schedule = 0 WHERE user_id = ?', [startTime, endTime, shiftName, isRepeat ? 1 : 0, targetUser.id]); 
            saveDatabase();
            
            const repeatStr = isRepeat ? "**Hàng ngày**" : "**Chỉ hôm nay**";
            return interaction.reply({ content: `✅ Đã set lịch cho <@${targetUser.id}>: **Ca ${shiftName}** (${startTime} - ${endTime}) (${repeatStr}).` });
        }

        if (commandName === 'xemca') {
            await interaction.deferReply();
            try {
                const buffer = await generateAllSchedulesImage(guild);
                if (!buffer) return interaction.editReply("📅 Hiện chưa có ai được set lịch trực.");
                const attachment = new AttachmentBuilder(buffer, { name: 'all_schedules.png' });
                return interaction.editReply({ files: [attachment] });
            } catch (e) { return interaction.editReply("❌ Lỗi khi tạo ảnh lịch trực."); }
        }

        if (commandName === 'setupduty') { config.dutyChannelId = channel.id; saveConfig(); return interaction.reply(`✅ Đã đặt kênh Log On/Off.`); }
        if (commandName === 'setupwarning') { config.warningChannelId = channel.id; saveConfig(); return interaction.reply(`✅ Đã đặt kênh Cảnh báo.`); }
        if (commandName === 'setupleave') { config.leaveChannelId = channel.id; saveConfig(); return interaction.reply(`✅ Đã đặt kênh Nghỉ phép.`); }
        if (commandName === 'resetuser') { const targetUser = options.getUser('user'); db.run('DELETE FROM users WHERE user_id = ?', [targetUser.id]); db.run('DELETE FROM history WHERE user_id = ?', [targetUser.id]); db.run('DELETE FROM weekly_history WHERE user_id = ?', [targetUser.id]); db.run('DELETE FROM monthly_history WHERE user_id = ?', [targetUser.id]); saveDatabase(); if (config.boardChannelId) updateDutyBoard(client.channels.cache.get(config.boardChannelId)); return interaction.reply(`✅ Đã xóa dữ liệu của <@${targetUser.id}>.`); }
        if (commandName === 'resetdata') { db.run('DELETE FROM users'); db.run('DELETE FROM history'); db.run('DELETE FROM weekly_history'); db.run('DELETE FROM monthly_history'); saveDatabase(); if (config.boardChannelId) updateDutyBoard(client.channels.cache.get(config.boardChannelId)); return interaction.reply("💥 **ĐÃ RESET TOÀN BỘ DỮ LIỆU!**"); }
        
        if (commandName === 'resetnghi') {
            const targetUser = options.getUser('user');
            db.run('UPDATE users SET is_on_leave = 0, leave_date = NULL WHERE user_id = ?', [targetUser.id]);
            saveDatabase();
            if (config.boardChannelId) updateDutyBoard(client.channels.cache.get(config.boardChannelId));
            return interaction.reply({ content: `✅ Đã gỡ trạng thái nghỉ phép cho <@${targetUser.id}>. Người này có thể On Duty trở lại.` });
        }

        if (commandName === 'export') {
            const stmtUsers = db.prepare('SELECT * FROM users'); const users = []; while (stmtUsers.step()) users.push(stmtUsers.getAsObject()); stmtUsers.free();
            const stmtHistory = db.prepare('SELECT * FROM history'); const history = []; while (stmtHistory.step()) history.push(stmtHistory.getAsObject()); stmtHistory.free();
            const stmtWeek = db.prepare('SELECT * FROM weekly_history'); const week = []; while (stmtWeek.step()) week.push(stmtWeek.getAsObject()); stmtWeek.free();
            const stmtMonth = db.prepare('SELECT * FROM monthly_history'); const month = []; while (stmtMonth.step()) month.push(stmtMonth.getAsObject()); stmtMonth.free();
            const stmtBlacklist = db.prepare('SELECT * FROM blacklist'); const blacklist = []; while (stmtBlacklist.step()) blacklist.push(stmtBlacklist.getAsObject()); stmtBlacklist.free();
            
            const backupData = { config, users, history, week, month, blacklist, exportDate: new Date().toISOString() };
            fs.writeFileSync('backup.json', JSON.stringify(backupData, null, 2));
            
            await interaction.deferReply({ ephemeral: true });
            try {
                if (ADMIN_ID !== 'ĐIỀN_ID_ADMIN_VÀO_ĐÂY' && ADMIN_ID) {
                    const adminUser = await client.users.fetch(ADMIN_ID);
                    await adminUser.send({ content: `📦 **FILE SAO LƯU TOÀN BỘ (Cấu hình + Dữ liệu)**`, files: [{ attachment: 'backup.json', name: 'backup_dutylist.json' }] });
                    return interaction.editReply({ content: `✅ Đã gửi file sao lưu qua tin nhắn riêng của bạn!` });
                } else {
                    return interaction.editReply({ content: `❌ Lỗi: Chưa cài đặt ADMIN_ID trong code để nhận file!`, files: [{ attachment: 'backup.json', name: 'backup_dutylist.json' }] });
                }
            } catch (e) {
                return interaction.editReply({ content: `❌ Không thể gửi tin nhắn riêng cho Admin (Có thể Admin đã chặn DM). Dưới đây là file trực tiếp:`, files: [{ attachment: 'backup.json', name: 'backup_dutylist.json' }] });
            }
        }
        if (commandName === 'import') {
            const attachment = options.getAttachment('file');
            if (!attachment.name.endsWith('.json')) return interaction.reply({ content: "❌ Chỉ nhận file `.json`.", ephemeral: true });
            await interaction.deferReply({ ephemeral: true });
            https.get(attachment.url, (res) => {
                let data = ''; res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const backup = JSON.parse(data);
                        if (backup.config) { config = backup.config; saveConfig(); }
                        db.run('DELETE FROM users'); db.run('DELETE FROM history'); db.run('DELETE FROM weekly_history'); db.run('DELETE FROM monthly_history'); db.run('DELETE FROM blacklist');
                        if (backup.users) { for (const u of backup.users) { db.run(`INSERT INTO users (user_id, is_on_duty, start_time, total_time, total_days, is_on_leave, leave_date, schedule_start, schedule_end, has_warned_schedule, unit, repeat_daily, shift_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [u.user_id, u.is_on_duty, u.start_time, u.total_time, u.total_days, u.is_on_leave, u.leave_date, u.schedule_start, u.schedule_end, u.has_warned_schedule, u.unit || "Chưa cập nhật", u.repeat_daily || 0, u.shift_name || null]); } }
                        if (backup.history) { for (const h of backup.history) db.run(`INSERT INTO history (user_id, date) VALUES (?, ?)`, [h.user_id, h.date]); }
                        if (backup.week) { for (const w of backup.week) db.run(`INSERT INTO weekly_history (user_id, week_id, week_time) VALUES (?, ?, ?)`, [w.user_id, w.week_id, w.week_time]); }
                        if (backup.month) { for (const m of backup.month) db.run(`INSERT INTO monthly_history (user_id, month_id, month_time) VALUES (?, ?, ?)`, [m.user_id, m.month_id, m.month_time]); }
                        if (backup.blacklist) { for (const b of backup.blacklist) db.run(`INSERT INTO blacklist (user_id, reason, banned_by, date) VALUES (?, ?, ?, ?)`, [b.user_id, b.reason, b.banned_by, b.date]); }
                        saveDatabase(); 
                        if (config.boardChannelId) { const bChannel = client.channels.cache.get(config.boardChannelId); if (bChannel) updateDutyBoard(bChannel); }
                        interaction.editReply(`✅ **NHẬP DỮ LIỆU VÀ CẤU HÌNH THÀNH CÔNG!**`);
                    } catch (e) { console.error(e); interaction.editReply("❌ Lỗi định dạng file JSON."); }
                });
            }).on("error", () => interaction.editReply("❌ Lỗi tải file."));
            return;
        }

        if (commandName === 'setstatus') {
            const presence = options.getString('presence');
            const type = options.getString('type');
            const text = options.getString('text');
            const activityTypes = { 'PLAYING': ActivityType.Playing, 'WATCHING': ActivityType.Watching, 'LISTENING': ActivityType.Listening };
            client.user.setPresence({ status: presence, activities: [{ name: text, type: activityTypes[type] }] });
            return interaction.reply({ content: `✅ Đã đổi trạng thái thành **${presence.toUpperCase()}** | **${type} ${text}**`, ephemeral: true });
        }

        if (commandName === 'chat') {
            const targetChannel = options.getChannel('channel');
            const messageContent = options.getString('message');
            const imageAttachment = options.getAttachment('image');
            try {
                const payload = {};
                if (messageContent) payload.content = messageContent;
                if (imageAttachment) payload.files = [{ attachment: imageAttachment.url, name: imageAttachment.name }];
                if (!payload.content && !payload.files) return interaction.reply({ content: "❌ Bạn phải nhập nội dung tin nhắn hoặc đính kèm file!", ephemeral: true });
                await targetChannel.send(payload);
                return interaction.reply({ content: `✅ Đã gửi tin nhắn tới <#${targetChannel.id}>.`, ephemeral: true });
            } catch (e) { return interaction.reply({ content: `❌ Không thể gửi tin nhắn tới kênh này (Có thể bot thiếu quyền).`, ephemeral: true }); }
        }

        if (commandName === 'blacklist') {
            const targetUser = options.getUser('user');
            const reason = options.getString('reason');
            const targetChannel = options.getChannel('channel') || (config.warningChannelId ? client.channels.cache.get(config.warningChannelId) : client.channels.cache.get(config.boardChannelId));
            if (!targetChannel) return interaction.reply({ content: "❌ Không tìm thấy kênh thông báo. Hãy setup kênh Cảnh báo trước!", ephemeral: true });

            const now = new Date();
            const dateStr = now.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
            db.run('INSERT OR REPLACE INTO blacklist (user_id, reason, banned_by, date) VALUES (?, ?, ?, ?)', [targetUser.id, reason, "Chief Of Police", dateStr]);
            saveDatabase();

            const blacklistEmbed = new EmbedBuilder().setTitle('🚫 THÔNG BÁO BLACKLIST (DANH SÁCH ĐEN)').setDescription(`**Đối tượng:** <@${targetUser.id}>\n**Lý do:** ${reason}\n**Người xử lý:** Chief Of Police\n**Thời gian:** ${dateStr}`).setColor(0xFF0000).setThumbnail(targetUser.displayAvatarURL()).setFooter({ text: 'Hệ Thống Quản Lý LSPD • GtaNetWork' }).setTimestamp();
            await targetChannel.send({ embeds: [blacklistEmbed] });

            try { const dmEmbed = new EmbedBuilder().setTitle('🚫 BẠN ĐÃ BỊ ĐƯA VÀO DANH SÁCH ĐEN').setDescription(`Bạn đã bị **Chief Of Police** đưa vào danh sách đen.\n**Lý do:** ${reason}`).setColor(0xFF0000).setTimestamp(); await targetUser.send({ embeds: [dmEmbed] }); } catch (e) {}
            return interaction.reply({ content: `✅ Đã đưa <@${targetUser.id}> vào danh sách đen và thông báo tới <#${targetChannel.id}>.`, ephemeral: true });
        }

        if (commandName === 'setdonvi') {
            const targetUser = options.getUser('user');
            const unitName = options.getString('unit');
            getOrCreateUser(targetUser.id);
            db.run('UPDATE users SET unit = ? WHERE user_id = ?', [unitName, targetUser.id]);
            saveDatabase();
            return interaction.reply({ content: `✅ Đã set đơn vị cho <@${targetUser.id}> thành **${unitName}**.` });
        }

        if (commandName === 'hoso') {
            await interaction.deferReply();
            const targetUser = options.getUser('user');
            const member = await guild.members.fetch(targetUser.id).catch(() => null);
            if (!member) return interaction.editReply("❌ Không tìm thấy người này trong server.");

            try {
                const buffer = await generateProfileImage(targetUser, member);
                const attachment = new AttachmentBuilder(buffer, { name: 'hoso.png' });
                return interaction.editReply({ files: [attachment] });
            } catch (e) { return interaction.editReply("❌ Lỗi khi tạo ảnh hồ sơ."); }
        }

        if (commandName === 'bxhtuan') {
            await interaction.deferReply();
            try {
                const buffer = await generateTimeBXHImage(guild, 'week');
                if (!buffer) return interaction.editReply("Tuần này chưa có ai trực.");
                const attachment = new AttachmentBuilder(buffer, { name: 'bxhtuan.png' });
                return interaction.editReply({ files: [attachment] });
            } catch (e) { return interaction.editReply("Lỗi khi tạo ảnh BXH Tuần."); }
        }

        if (commandName === 'bxhthang') {
            await interaction.deferReply();
            try {
                const buffer = await generateTimeBXHImage(guild, 'month');
                if (!buffer) return interaction.editReply("Tháng này chưa có ai trực.");
                const attachment = new AttachmentBuilder(buffer, { name: 'bxhthang.png' });
                return interaction.editReply({ files: [attachment] });
            } catch (e) { return interaction.editReply("Lỗi khi tạo ảnh BXH Tháng."); }
        }
    }

    if (!interaction.isButton()) return;
    if (!isDbReady) return interaction.reply({ content: "Hệ thống đang khởi động!", ephemeral: true });

    const logDutyChannel = config.dutyChannelId ? client.channels.cache.get(config.dutyChannelId) : client.channels.cache.get(config.boardChannelId);
    const logLeaveChannel = config.leaveChannelId ? client.channels.cache.get(config.leaveChannelId) : client.channels.cache.get(config.boardChannelId);

    if (interaction.customId === 'leave_btn') {
        const user = getOrCreateUser(interaction.user.id);
        if (user.is_on_leave === 1) return interaction.reply({ content: "❌ Bạn đã xin nghỉ hôm nay rồi!", ephemeral: true });
        
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`approve_leave_${interaction.user.id}`).setLabel('Chấp nhận').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`deny_leave_${interaction.user.id}`).setLabel('Từ chối').setStyle(ButtonStyle.Danger)
        );
        
        const now = new Date();
        const timeStr = now.toLocaleTimeString('vi-VN', { hour12: false, timeZone: 'Asia/Ho_Chi_Minh' });
        const dateStr = now.toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

        const leaveEmbed = new EmbedBuilder().setTitle('📩 ĐƠN XIN NGHỈ PHÉP MỚI').setDescription(`**Nhân viên:** <@${interaction.user.id}>\n**Thời gian gửi:** ${timeStr} - ${dateStr}\n\nVui lòng Admin xem xét và bấm nút bên dưới để duyệt.`).setColor(0xFFA500).setThumbnail(interaction.user.displayAvatarURL()).setFooter({ text: 'Hệ Thống Quản Lý LSPD • GtaNetWork' }).setTimestamp();
        if(logLeaveChannel) await logLeaveChannel.send({ embeds: [leaveEmbed], components: [row] });
        return interaction.reply({ content: "✅ Đã gửi đơn xin nghỉ đến Admin.", ephemeral: true });
    }

    if (interaction.customId.startsWith('approve_leave_')) {
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: "❌ Chỉ Admin Server mới có quyền duyệt đơn xin nghỉ!", ephemeral: true });

        const targetId = interaction.customId.split('_')[2];
        const now = new Date();
        const dateStr = now.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
        const today = new Date().toISOString().split('T')[0]; 
        db.run('UPDATE users SET is_on_leave = 1, leave_date = ? WHERE user_id = ?', [today, targetId]); saveDatabase();

        try { 
            const u = await client.users.fetch(targetId); 
            const dmEmbed = new EmbedBuilder().setTitle('✅ ĐƠN XIN NGHỈ ĐÃ ĐƯỢC DUYỆT').setDescription(`**Chào ${u.username},**\n\nĐơn xin nghỉ phép của bạn đã được **Chief Of Police** phê duyệt thành công.\n\n**Thời gian duyệt:** ${dateStr}\n**Trạng thái:** Được phép nghỉ phép\n\n*Chúc bạn có một ngày nghỉ vui vẻ! Hệ thống sẽ tự động mở khóa On Duty vào 00:00 ngày mai.*`).setColor(0x00FF00).setThumbnail(u.displayAvatarURL()).setFooter({ text: 'Hệ Thống Quản Lý LSPD • GtaNetWork' }).setTimestamp();
            await u.send({ embeds: [dmEmbed] }); 
        } catch (e) {}
        return interaction.update({ content: `✅ **${interaction.user.username}** đã duyệt đơn xin nghỉ cho <@${targetId}>.`, embeds: [], components: [] });
    }

    if (interaction.customId.startsWith('deny_leave_')) {
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: "❌ Chỉ Admin Server mới có quyền từ chối đơn xin nghỉ!", ephemeral: true });

        const targetId = interaction.customId.split('_')[2];
        const now = new Date();
        const dateStr = now.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

        try { 
            const u = await client.users.fetch(targetId); 
            const dmEmbed = new EmbedBuilder().setTitle('❌ ĐƠN XIN NGHỈ BỊ TỪ CHỐI').setDescription(`**Chào ${u.username},**\n\nRất tiếc, đơn xin nghỉ phép của bạn đã bị **Chief Of Police** từ chối.\n\n**Thời gian xử lý:** ${dateStr}\n\n*Vui lòng tiếp tục công việc bình thường.*`).setColor(0xFF0000).setThumbnail(u.displayAvatarURL()).setFooter({ text: 'Hệ Thống Quản Lý LSPD • GtaNetWork' }).setTimestamp();
            await u.send({ embeds: [dmEmbed] }); 
        } catch (e) { console.log("Không thể gửi DM."); }

        return interaction.update({ content: `❌ **${interaction.user.username}** đã từ chối đơn xin nghỉ của <@${targetId}>.`, embeds: [], components: [] });
    }

    if (interaction.customId === 'onduty_btn' || interaction.customId === 'offduty_btn' || interaction.customId === 'leave_btn') {
        if (isBlacklisted(interaction.user.id)) return interaction.reply({ content: "🚫 Bạn đang nằm trong danh sách đen (Blacklist) của Server. Không thể thực hiện hành động này!", ephemeral: true });
        if (REQUIRED_ROLE_ID && REQUIRED_ROLE_ID !== 'ĐIỀN_ID_ROLE_VÀO_ĐÂY') {
            if (!interaction.member.roles.cache.has(REQUIRED_ROLE_ID)) return interaction.reply({ content: "❌ Bạn không có Role nhân sự, không thể bấm On/Off Duty!", ephemeral: true });
        }
    }

    if (interaction.customId !== 'onduty_btn' && interaction.customId !== 'offduty_btn') return;

    const user = getOrCreateUser(interaction.user.id);
    const voiceChannel = interaction.member.voice.channel;
    const currentWeek = getWeekId();
    const currentMonth = getMonthId();

    if (interaction.customId === 'onduty_btn') {
        if (user.is_on_leave === 1) return interaction.reply({ content: "Bạn Đang nghỉ phép!", ephemeral: true });
        if (user.is_on_duty) return interaction.reply({ content: "Bạn Hiện Đang Onuty!", ephemeral: true });
        if (!voiceChannel) return interaction.reply({ content: "Vào Voice Trước Khi Bấm Onduty!", ephemeral: true });
        
        checkAndAddDay(user.user_id);
        db.run('UPDATE users SET is_on_duty = 1, start_time = ?, has_warned_schedule = 0 WHERE user_id = ?', [Date.now(), user.user_id]); 
        saveDatabase();
        
        await interaction.reply({ content: `Bắt đầu ca trực lúc ${getVNTime()}.`, ephemeral: true });
        if (logDutyChannel) {
            const now = new Date(); const timeStr = now.toLocaleTimeString('vi-VN', { hour12: false, timeZone: 'Asia/Ho_Chi_Minh' }); const footerTime = now.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Ho_Chi_Minh' });
            const embed = new EmbedBuilder().setTitle('Bắt đầu ca trực').setDescription(`**Thành viên:** <@${interaction.user.id}>\n**Thời gian:** ${timeStr}\n**Voice Channel:** ${voiceChannel.name}`).setColor(0x00FF00).setFooter({ text: `Hôm nay lúc ${footerTime}` }); 
            await logDutyChannel.send({ embeds: [embed] });
        }
        updateDutyBoard(interaction.channel);
    } else if (interaction.customId === 'offduty_btn') {
        if (!user.is_on_duty) return interaction.reply({ content: "Bạn chưa On Duty!", ephemeral: true });
        
        const sessionTime = Date.now() - user.start_time; 
        const newTotal = user.total_time + sessionTime;
        
        db.run('UPDATE users SET is_on_duty = 0, start_time = 0, total_time = ? WHERE user_id = ?', [newTotal, user.user_id]); 
        
        const weekStmt = db.prepare('SELECT * FROM weekly_history WHERE user_id = ? AND week_id = ?');
        weekStmt.bind([user.user_id, currentWeek]);
        if (weekStmt.step()) { const currentWeekTime = weekStmt.getAsObject().week_time; db.run('UPDATE weekly_history SET week_time = ? WHERE user_id = ? AND week_id = ?', [currentWeekTime + sessionTime, user.user_id, currentWeek]); } 
        else { db.run('INSERT INTO weekly_history (user_id, week_id, week_time) VALUES (?, ?, ?)', [user.user_id, currentWeek, sessionTime]); }
        weekStmt.free();

        const monthStmt = db.prepare('SELECT * FROM monthly_history WHERE user_id = ? AND month_id = ?');
        monthStmt.bind([user.user_id, currentMonth]);
        if (monthStmt.step()) { const currentMonthTime = monthStmt.getAsObject().month_time; db.run('UPDATE monthly_history SET month_time = ? WHERE user_id = ? AND month_id = ?', [currentMonthTime + sessionTime, user.user_id, currentMonth]); } 
        else { db.run('INSERT INTO monthly_history (user_id, month_id, month_time) VALUES (?, ?, ?)', [user.user_id, currentMonth, sessionTime]); }
        monthStmt.free();
        saveDatabase();
        
        await interaction.reply({ content: `Đã kết thúc ca. Ca này: **${formatTime(sessionTime)}**`, ephemeral: true });
        if (logDutyChannel) {
            const now = new Date(); const timeStr = now.toLocaleTimeString('vi-VN', { hour12: false, timeZone: 'Asia/Ho_Chi_Minh' }); const footerTime = now.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Ho_Chi_Minh' });
            const embed = new EmbedBuilder().setTitle('Kết thúc ca trực').setDescription(`**Thành viên:** <@${interaction.user.id}>\n**Thời gian ca này:** ${formatTime(sessionTime)}\n**Tổng thời gian:** ${formatTime(newTotal)}\n**Thời điểm:** ${timeStr}`).setColor(0xFF0000).setFooter({ text: `Hôm nay lúc ${footerTime}` });
            await logDutyChannel.send({ embeds: [embed] });
        }
        updateDutyBoard(interaction.channel);
    }
});

client.on(Events.MessageCreate, async message => {
    if (message.author.bot || !isDbReady) return;

    if (message.content === '!setup' && message.member.permissions.has(PermissionFlagsBits.Administrator)) {
        await message.delete().catch(() => {});
        config.boardChannelId = message.channel.id;
        if (!config.dutyChannelId) config.dutyChannelId = message.channel.id;
        if (!config.warningChannelId) config.warningChannelId = message.channel.id;
        if (!config.leaveChannelId) config.leaveChannelId = message.channel.id;
        saveConfig(); 
        await updateDutyBoard(message.channel);
        return message.channel.send("✅ Đã setup tại kênh này!");
    }

    if (message.content === '!bxh') {
        try {
            const buffer = await generateBXHImage(message.guild);
            if (!buffer) return message.reply("Chưa có dữ liệu xếp hạng.");
            const attachment = new AttachmentBuilder(buffer, { name: 'bxh.png' });
            message.reply({ files: [attachment] });
        } catch (e) { message.reply("Lỗi khi tạo ảnh BXH."); }
    }

    // LỆNH !stats (ĐÃ SỬA LỖI THIẾU HÀM)
    if (message.content === '!stats') {
        try {
            const buffer = await generateStatsImage(message.guild);
            if (!buffer) return message.reply("Chưa có dữ liệu thống kê.");
            const attachment = new AttachmentBuilder(buffer, { name: 'stats.png' });
            message.reply({ files: [attachment] });
        } catch (e) { message.reply("Lỗi khi tạo ảnh Thống kê."); }
    }
});

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
    if (!isDbReady) return;
    const user = getOrCreateUser(oldState.id);
    if (user.is_on_duty && oldState.channelId && !newState.channelId && user.is_on_leave !== 1) {
        const sT = Date.now() - user.start_time;
        const currentWeek = getWeekId();
        const currentMonth = getMonthId();
        
        db.run('UPDATE users SET is_on_duty = 0, start_time = 0, total_time = total_time + ? WHERE user_id = ?', [sT, oldState.id]); 
        
        const weekStmt = db.prepare('SELECT * FROM weekly_history WHERE user_id = ? AND week_id = ?');
        weekStmt.bind([oldState.id, currentWeek]);
        if (weekStmt.step()) { const currentWeekTime = weekStmt.getAsObject().week_time; db.run('UPDATE weekly_history SET week_time = ? WHERE user_id = ? AND week_id = ?', [currentWeekTime + sT, oldState.id, currentWeek]); } 
        else { db.run('INSERT INTO weekly_history (user_id, week_id, week_time) VALUES (?, ?, ?)', [oldState.id, currentWeek, sT]); }
        weekStmt.free();

        const monthStmt = db.prepare('SELECT * FROM monthly_history WHERE user_id = ? AND month_id = ?');
        monthStmt.bind([oldState.id, currentMonth]);
        if (monthStmt.step()) { const currentMonthTime = monthStmt.getAsObject().month_time; db.run('UPDATE monthly_history SET month_time = ? WHERE user_id = ? AND month_id = ?', [currentMonthTime + sT, oldState.id, currentMonth]); } 
        else { db.run('INSERT INTO monthly_history (user_id, month_id, month_time) VALUES (?, ?, ?)', [oldState.id, currentMonth, sT]); }
        monthStmt.free();
        saveDatabase();

        const wC = config.warningChannelId ? client.channels.cache.get(config.warningChannelId) : client.channels.cache.get(config.boardChannelId);
        if (wC) { const warnEmbed = new EmbedBuilder().setTitle('CẢNH BÁO RỚT MẠNG').setDescription(`**Nhân viên:** <@${oldState.id}>\n**Lý do:** Tự động rời Voice Channel khi đang On Duty.\n**Thời gian ca này:** ${formatTime(sT)}`).setColor(0xFFA500).setTimestamp(); wC.send({ embeds: [warnEmbed] }); }
    }
});

setInterval(() => {
    if (!isDbReady) return;
    const now = new Date(); const vnTime = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" })); const cM = vnTime.getHours() * 60 + vnTime.getMinutes();
    if (config.boardChannelId) { const channel = client.channels.cache.get(config.boardChannelId); if (channel) updateDutyBoard(channel); }
    const stmt = db.prepare('SELECT * FROM users WHERE schedule_start IS NOT NULL'); const users = []; while (stmt.step()) users.push(stmt.getAsObject()); stmt.free();
    const wC = config.warningChannelId ? client.channels.cache.get(config.warningChannelId) : client.channels.cache.get(config.boardChannelId);
    for (let u of users) {
        u = checkLeaveStatus(u); if (!u.schedule_start || !u.schedule_end) continue;
        const sM = timeToMinutes(u.schedule_start), eM = timeToMinutes(u.schedule_end);
        if (cM >= sM && cM <= eM && u.is_on_duty === 0 && u.has_warned_schedule === 0 && u.is_on_leave === 0) {
            if (wC) { const warnEmbed = new EmbedBuilder().setTitle('CẢNH BÁO TRỄ CA TRỰC').setDescription(`**Nhân viên:** <@${u.user_id}>\n**Ca trực:** **${u.shift_name || 'Tùy chỉnh'}** (${u.schedule_start} - ${u.schedule_end})\n**Lý do:** Đã đến giờ nhưng chưa bấm nút **On Duty**!`).setColor(0xFFA500).setTimestamp(); wC.send({ embeds: [warnEmbed] }); }
            db.run('UPDATE users SET has_warned_schedule = 1 WHERE user_id = ?', [u.user_id]); saveDatabase();
        }
        if (cM > eM && u.has_warned_schedule === 1) { db.run('UPDATE users SET has_warned_schedule = 0 WHERE user_id = ?', [u.user_id]); saveDatabase(); }
    }
}, 60000);

setInterval(() => {
    if (!isDbReady) return;
    const now = new Date();
    const vnTime = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" }));
    
    if (vnTime.getHours() === 0 && vnTime.getMinutes() === 0) {
        db.run('UPDATE users SET has_warned_schedule = 0');
        saveDatabase();
        console.log("🕛 Đã reset cờ cảnh báo lịch trực cho ngày mới.");
    }
}, 60 * 1000);

const app = express(); const PORT = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('Bot online!'));
app.listen(PORT, () => {
    console.log(`Web server cổng ${PORT}`);
    if (RENDER_EXTERNAL_URL) { setInterval(() => { https.get(RENDER_EXTERNAL_URL, () => console.log("Tự ping giữ thức!")).on("error", (err) => console.log("Lỗi ping:", err.message)); }, 10 * 60 * 1000); }
});

if (!TOKEN) { console.error("❌ CHƯA CÓ TOKEN!"); } 
else { client.login(TOKEN).catch(e => console.error("❌ LỖI LOGIN:", e.message)); }
