const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, Events, PermissionFlagsBits, REST, Routes, SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const initSqlJs = require('sql.js');
const fs = require('fs');
const express = require('express');
const https = require('https');

const TOKEN = process.env.TOKEN;
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL;

// ==========================================
// ID ADMIN ĐÃ ĐƯỢC CẬP NHẬT
// ==========================================
const ADMIN_ID = '1498554147304247296'; 
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
            has_warned_schedule INTEGER DEFAULT 0
        )`);
        
        try { db.run('ALTER TABLE users ADD COLUMN total_days INTEGER DEFAULT 0'); } catch (e) {}
        try { db.run('ALTER TABLE users ADD COLUMN is_on_leave INTEGER DEFAULT 0'); } catch (e) {}
        try { db.run('ALTER TABLE users ADD COLUMN leave_date TEXT DEFAULT NULL'); } catch (e) {}
        try { db.run('ALTER TABLE users ADD COLUMN schedule_start TEXT DEFAULT NULL'); } catch (e) {}
        try { db.run('ALTER TABLE users ADD COLUMN schedule_end TEXT DEFAULT NULL'); } catch (e) {}
        try { db.run('ALTER TABLE users ADD COLUMN has_warned_schedule INTEGER DEFAULT 0'); } catch (e) {}
        
        db.run(`CREATE TABLE IF NOT EXISTS history (user_id TEXT, date TEXT, PRIMARY KEY (user_id, date))`);
        db.run(`CREATE TABLE IF NOT EXISTS weekly_history (
            user_id TEXT, week_id TEXT, week_time INTEGER DEFAULT 0,
            PRIMARY KEY (user_id, week_id)
        )`);
        
        saveDatabase(); isDbReady = true;
        console.log("✅ Database đã sẵn sàng!");
    } catch (error) { console.error("❌ LỖI DATABASE:", error); }
}

function saveDatabase() { if (db) { try { fs.writeFileSync('duty.db', Buffer.from(db.export())); } catch (e) {} } }

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
    if (!isDbReady) return { user_id: userId, is_on_duty: 0, start_time: 0, total_time: 0, total_days: 0, is_on_leave: 0, leave_date: null };
    const stmt = db.prepare('SELECT * FROM users WHERE user_id = ?'); stmt.bind([userId]);
    let user = null; if (stmt.step()) user = stmt.getAsObject(); stmt.free();
    if (!user) { db.run('INSERT INTO users (user_id) VALUES (?)', [userId]); saveDatabase(); user = { user_id: userId, is_on_duty: 0, start_time: 0, total_time: 0, total_days: 0, is_on_leave: 0, leave_date: null }; } else { user = checkLeaveStatus(user); }
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
    new SlashCommandBuilder().setName('settime').setDescription('Cài đặt lịch trực').addUserOption(opt => opt.setName('user').setDescription('Chọn nhân viên').setRequired(true)).addStringOption(opt => opt.setName('start').setDescription('Giờ bắt đầu (VD: 14:00)').setRequired(true)).addStringOption(opt => opt.setName('end').setDescription('Giờ kết thúc (VD: 15:30)').setRequired(true)),
    new SlashCommandBuilder().setName('setupduty').setDescription('Đặt kênh Log On/Off'),
    new SlashCommandBuilder().setName('setupwarning').setDescription('Đặt kênh Cảnh báo'),
    new SlashCommandBuilder().setName('setupleave').setDescription('Đặt kênh Nghỉ phép'),
    new SlashCommandBuilder().setName('resetuser').setDescription('Reset dữ liệu 1 người').addUserOption(opt => opt.setName('user').setDescription('Chọn nhân viên').setRequired(true)),
    new SlashCommandBuilder().setName('resetdata').setDescription('Xóa sạch toàn bộ dữ liệu'),
    new SlashCommandBuilder().setName('resetnghi').setDescription('Gỡ trạng thái nghỉ phép cho nhân viên').addUserOption(opt => opt.setName('user').setDescription('Chọn nhân viên').setRequired(true)),
    new SlashCommandBuilder().setName('export').setDescription('Xuất file sao lưu (Gửi qua DM)'),
    new SlashCommandBuilder().setName('import').setDescription('Nhập file sao lưu').addAttachmentOption(opt => opt.setName('file').setDescription('File json').setRequired(true))
].map(command => command.toJSON());

client.once(Events.ClientReady, async () => {
    console.log(`🚀 BOT ĐÃ ONLINE: ${client.user.tag}`);
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
    ctx.fillStyle = '#ffffff'; ctx.font = 'bold 32px sans-serif'; ctx.fillText('Danh Sách Nhân Sự LSPD GtaNetWork', padding, 50);
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

// 2. Vẽ Bảng Xếp Hạng (BXH)
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
    ctx.fillStyle = '#FFD700'; ctx.font = 'bold 34px sans-serif'; ctx.fillText('Bảng Xếp Hạng Nhận Sự LSPD - GtaNetWork', padding, 50);
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

// 3. Vẽ Bảng Thống Kê (Stats)
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
        let timeText = diffMinutes < 1 ? `**Bảng chấm công vừa được cập nhật: Vừa xong**` : `**Bảng chấm công vừa được cập nhật: ${diffMinutes} phút**`;
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
            const embed = new EmbedBuilder().setTitle("Danh Sách LSPD GtaNetWork").setDescription(desc).setColor(0x2b2d31);
            await channel.send({ content: timeText, embeds: [embed], components: [row] });
        }
    } catch (e) { console.error(e); }
}

client.on(Events.InteractionCreate, async interaction => {
    // KIỂM TRA QUYỀN ADMIN CHO LỆNH SLASH
    if (interaction.isChatInputCommand()) {
        if (!isDbReady) return interaction.reply({ content: "Đang khởi động!", ephemeral: true });
        
        if (interaction.user.id !== ADMIN_ID) {
            return interaction.reply({ content: "❌ Bạn không có quyền sử dụng lệnh này!", ephemeral: true });
        }

        const { commandName, options, channel } = interaction;

        if (commandName === 'settime') {
            const targetUser = options.getUser('user'); const startTime = options.getString('start'); const endTime = options.getString('end');
            if (!startTime.includes(':') || !endTime.includes(':')) return interaction.reply({ content: "Giờ phải dạng HH:MM!", ephemeral: true });
            getOrCreateUser(targetUser.id);
            db.run('UPDATE users SET schedule_start = ?, schedule_end = ?, has_warned_schedule = 0 WHERE user_id = ?', [startTime, endTime, targetUser.id]); saveDatabase();
            return interaction.reply({ content: `✅ Đã set lịch cho <@${targetUser.id}>: Từ **${startTime}** đến **${endTime}**.` });
        }
        if (commandName === 'setupduty') { config.dutyChannelId = channel.id; saveConfig(); return interaction.reply(`✅ Đã đặt kênh Log On/Off.`); }
        if (commandName === 'setupwarning') { config.warningChannelId = channel.id; saveConfig(); return interaction.reply(`✅ Đã đặt kênh Cảnh báo.`); }
        if (commandName === 'setupleave') { config.leaveChannelId = channel.id; saveConfig(); return interaction.reply(`✅ Đã đặt kênh Nghỉ phép.`); }
        if (commandName === 'resetuser') { const targetUser = options.getUser('user'); db.run('DELETE FROM users WHERE user_id = ?', [targetUser.id]); db.run('DELETE FROM history WHERE user_id = ?', [targetUser.id]); db.run('DELETE FROM weekly_history WHERE user_id = ?', [targetUser.id]); saveDatabase(); if (config.boardChannelId) updateDutyBoard(client.channels.cache.get(config.boardChannelId)); return interaction.reply(`✅ Đã xóa dữ liệu của <@${targetUser.id}>.`); }
        if (commandName === 'resetdata') { db.run('DELETE FROM users'); db.run('DELETE FROM history'); db.run('DELETE FROM weekly_history'); saveDatabase(); if (config.boardChannelId) updateDutyBoard(client.channels.cache.get(config.boardChannelId)); return interaction.reply("💥 **ĐÃ RESET TOÀN BỘ DỮ LIỆU!**"); }
        
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
            fs.writeFileSync('backup.json', JSON.stringify({ users, history, week, exportDate: new Date().toISOString() }, null, 2));
            
            await interaction.deferReply({ ephemeral: true });
            try {
                if (ADMIN_ID !== 'ĐIỀN_ID_ADMIN_VÀO_ĐÂY' && ADMIN_ID) {
                    const adminUser = await client.users.fetch(ADMIN_ID);
                    await adminUser.send({ content: `📦 **FILE SAO LƯU DỮ LIỆU BOT**`, files: [{ attachment: 'backup.json', name: 'backup_dutylist.json' }] });
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
                        db.run('DELETE FROM users'); db.run('DELETE FROM history'); db.run('DELETE FROM weekly_history');
                        for (const u of backup.users) { db.run(`INSERT INTO users (user_id, is_on_duty, start_time, total_time, total_days, is_on_leave, leave_date, schedule_start, schedule_end, has_warned_schedule) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [u.user_id, u.is_on_duty, u.start_time, u.total_time, u.total_days, u.is_on_leave, u.leave_date, u.schedule_start, u.schedule_end, u.has_warned_schedule]); }
                        for (const h of backup.history) db.run(`INSERT INTO history (user_id, date) VALUES (?, ?)`, [h.user_id, h.date]);
                        if (backup.week) { for (const w of backup.week) db.run(`INSERT INTO weekly_history (user_id, week_id, week_time) VALUES (?, ?, ?)`, [w.user_id, w.week_id, w.week_time]); }
                        saveDatabase(); if (config.boardChannelId) updateDutyBoard(client.channels.cache.get(config.boardChannelId));
                        interaction.editReply(`✅ **NHẬP DỮ LIỆU THÀNH CÔNG!**`);
                    } catch (e) { interaction.editReply("❌ Lỗi định dạng file JSON."); }
                });
            }).on("error", () => interaction.editReply("❌ Lỗi tải file."));
            return;
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

        const leaveEmbed = new EmbedBuilder()
            .setTitle('📩 ĐƠN XIN NGHỈ PHÉP MỚI')
            .setDescription(`**Nhân viên:** <@${interaction.user.id}>\n**Thời gian gửi:** ${timeStr} - ${dateStr}\n\nVui lòng Admin xem xét và bấm nút bên dưới để duyệt.`)
            .setColor(0xFFA500) 
            .setThumbnail(interaction.user.displayAvatarURL())
            .setFooter({ text: 'Hệ Thống Quản Lý LSPD • GtaNetWork' })
            .setTimestamp();

        if(logLeaveChannel) {
            await logLeaveChannel.send({ embeds: [leaveEmbed], components: [row] });
        }
        return interaction.reply({ content: "✅ Đã gửi đơn xin nghỉ đến Admin.", ephemeral: true });
    }

    if (interaction.customId.startsWith('approve_leave_') || interaction.customId.startsWith('deny_leave_')) {
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ content: "❌ Chỉ Admin Server mới có quyền duyệt đơn xin nghỉ!", ephemeral: true });
        }

        const targetId = interaction.customId.split('_')[2];
        const isApprove = interaction.customId.startsWith('approve_leave_');

        if (isApprove) {
            const today = new Date().toISOString().split('T')[0]; 
            db.run('UPDATE users SET is_on_leave = 1, leave_date = ? WHERE user_id = ?', [today, targetId]); saveDatabase();
            try { const u = await client.users.fetch(targetId); await u.send(`✅ **THÔNG BÁO:** Đơn xin nghỉ phép của bạn đã được Chief Of Police **${interaction.user.username}** phê duyệt.`); } catch (e) {}
            return interaction.update({ content: `✅ **${interaction.user.username}** đã duyệt đơn xin nghỉ cho <@${targetId}>.`, embeds: [], components: [] });
        } else {
            try { const u = await client.users.fetch(targetId); await u.send(`❌ **THÔNG BÁO:** Đơn xin nghỉ phép của bạn đã bị Chief Of Police **${interaction.user.username}** từ chối.`); } catch (e) {}
            return interaction.update({ content: `❌ **${interaction.user.username}** đã từ chối đơn xin nghỉ của <@${targetId}>.`, embeds: [], components: [] });
        }
    }

    if (interaction.customId !== 'onduty_btn' && interaction.customId !== 'offduty_btn') return;

    const user = getOrCreateUser(interaction.user.id);
    const voiceChannel = interaction.member.voice.channel;
    const currentWeek = getWeekId();

    if (interaction.customId === 'onduty_btn') {
        if (user.is_on_leave === 1) return interaction.reply({ content: "❌ Đang nghỉ phép!", ephemeral: true });
        if (user.is_on_duty) return interaction.reply({ content: "Bạn đã On Duty rồi!", ephemeral: true });
        if (!voiceChannel) return interaction.reply({ content: "Vào Voice Channel trước đã!", ephemeral: true });
        
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
        if (weekStmt.step()) {
            const currentWeekTime = weekStmt.getAsObject().week_time;
            db.run('UPDATE weekly_history SET week_time = ? WHERE user_id = ? AND week_id = ?', [currentWeekTime + sessionTime, user.user_id, currentWeek]);
        } else {
            db.run('INSERT INTO weekly_history (user_id, week_id, week_time) VALUES (?, ?, ?)', [user.user_id, currentWeek, sessionTime]);
        }
        weekStmt.free();
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

// LỆNH TEXT (!setup, !bxh, !stats)
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
        
        db.run('UPDATE users SET is_on_duty = 0, start_time = 0, total_time = total_time + ? WHERE user_id = ?', [sT, oldState.id]); 
        
        const weekStmt = db.prepare('SELECT * FROM weekly_history WHERE user_id = ? AND week_id = ?');
        weekStmt.bind([oldState.id, currentWeek]);
        if (weekStmt.step()) {
            const currentWeekTime = weekStmt.getAsObject().week_time;
            db.run('UPDATE weekly_history SET week_time = ? WHERE user_id = ? AND week_id = ?', [currentWeekTime + sT, oldState.id, currentWeek]);
        } else {
            db.run('INSERT INTO weekly_history (user_id, week_id, week_time) VALUES (?, ?, ?)', [oldState.id, currentWeek, sT]);
        }
        weekStmt.free();
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
            if (wC) { const warnEmbed = new EmbedBuilder().setTitle('CẢNH BÁO TRỄ CA TRỰC').setDescription(`**Nhân viên:** <@${u.user_id}>\n**Lịch trực:** Từ **${u.schedule_start}** đến **${u.schedule_end}**\n**Lý do:** Đã đến giờ nhưng chưa bấm nút **On Duty**!`).setColor(0xFFA500).setTimestamp(); wC.send({ embeds: [warnEmbed] }); }
            db.run('UPDATE users SET has_warned_schedule = 1 WHERE user_id = ?', [u.user_id]); saveDatabase();
        }
        if (cM > eM && u.has_warned_schedule === 1) { db.run('UPDATE users SET has_warned_schedule = 0 WHERE user_id = ?', [u.user_id]); saveDatabase(); }
    }
}, 60000);

const app = express(); const PORT = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('Bot online!'));
app.listen(PORT, () => {
    console.log(`Web server cổng ${PORT}`);
    if (RENDER_EXTERNAL_URL) { setInterval(() => { https.get(RENDER_EXTERNAL_URL, () => console.log("Tự ping giữ thức!")).on("error", (err) => console.log("Lỗi ping:", err.message)); }, 10 * 60 * 1000); }
});

if (!TOKEN) { console.error("❌ CHƯA CÓ TOKEN!"); } 
else { client.login(TOKEN).catch(e => console.error("❌ LỖI LOGIN:", e.message)); }
