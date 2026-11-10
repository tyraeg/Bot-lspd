const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, Events, PermissionFlagsBits } = require('discord.js');
const initSqlJs = require('sql.js');
const fs = require('fs');
const express = require('express');

const TOKEN = process.env.TOKEN;
const LOG_DUTY_ID = process.env.LOG_DUTY_ID;
const LOG_WARNING_ID = process.env.LOG_WARNING_ID;
const LOG_LEAVE_ID = process.env.LOG_LEAVE_ID;
const DUTY_BOARD_CHANNEL_ID = process.env.DUTY_BOARD_CHANNEL_ID || ''; 

let db;
let isDbReady = false;

async function initDatabase() {
    try {
        const SQL = await initSqlJs();
        // Tự động xóa DB cũ nếu bị lỗi để tạo lại từ đầu
        if (fs.existsSync('duty.db')) {
            try {
                const filebuffer = fs.readFileSync('duty.db');
                db = new SQL.Database(filebuffer);
            } catch(e) {
                fs.unlinkSync('duty.db');
                db = new SQL.Database();
            }
        } else {
            db = new SQL.Database();
        }
        
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

        try { db.run(`CREATE TABLE IF NOT EXISTS history (user_id TEXT, date TEXT, PRIMARY KEY (user_id, date))`); } catch (e) {}
        
        saveDatabase();
        isDbReady = true;
        console.log("✅ Database đã sẵn sàng!");
    } catch (error) {
        console.error("❌ LỖI DATABASE:", error);
    }
}

function saveDatabase() {
    if (!db) return;
    try { fs.writeFileSync('duty.db', Buffer.from(db.export())); } catch (e) {}
}

function checkAndAddDay(userId) {
    if (!isDbReady) return;
    const today = new Date().toISOString().split('T')[0];
    const checkStmt = db.prepare('SELECT * FROM history WHERE user_id = ? AND date = ?');
    checkStmt.bind([userId, today]);
    const exists = checkStmt.step();
    checkStmt.free();
    if (!exists) {
        db.run('INSERT INTO history (user_id, date) VALUES (?, ?)', [userId, today]);
        db.run('UPDATE users SET total_days = total_days + 1 WHERE user_id = ?', [userId]);
        saveDatabase();
    }
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

const getOrCreateUser = (userId) => {
    if (!isDbReady) return { user_id: userId, is_on_duty: 0, start_time: 0, total_time: 0, total_days: 0, is_on_leave: 0, leave_date: null };
    const stmt = db.prepare('SELECT * FROM users WHERE user_id = ?');
    stmt.bind([userId]);
    let user = null;
    if (stmt.step()) user = stmt.getAsObject();
    stmt.free();
    if (!user) {
        db.run('INSERT INTO users (user_id) VALUES (?)', [userId]);
        saveDatabase();
        user = { user_id: userId, is_on_duty: 0, start_time: 0, total_time: 0, total_days: 0, is_on_leave: 0, leave_date: null };
    } else { user = checkLeaveStatus(user); }
    return user;
};

const formatTime = (ms) => {
    if (!ms || ms < 1000) return "0 Giây";
    const totalSeconds = Math.floor(ms / 1000);
    if (totalSeconds < 60) return `${totalSeconds} Giây`;
    const totalMinutes = Math.floor(totalSeconds / 60);
    if (totalMinutes < 60) return `${totalMinutes} Phút`;
    return `${Math.floor(totalMinutes / 60)} Giờ`;
};

const timeToMinutes = (timeStr) => {
    const [h, m] = timeStr.split(':').map(Number);
    return h * 60 + m;
};

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMembers, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages
    ]
});

// BẮT LỖI TOÀN CỤC (Nếu sai Token hay thiếu Intent sẽ in ra đỏ lòm)
process.on('unhandledRejection', error => {
    console.error('❌ LỖI NGHIÊM TRỌNG:', error);
});

client.once(Events.ClientReady, () => {
    console.log(`🚀 BOT ĐÃ ONLINE: ${client.user.tag}`);
    initDatabase();
});

client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isButton()) return;
    if (!isDbReady) return interaction.reply({ content: "Hệ thống đang khởi động, đợi xíu nhé!", ephemeral: true });

    const logDutyChannel = client.channels.cache.get(LOG_DUTY_ID);
    const logLeaveChannel = client.channels.cache.get(LOG_LEAVE_ID);

    if (interaction.customId === 'leave_btn') {
        const user = getOrCreateUser(interaction.user.id);
        if (user.is_on_leave === 1) return interaction.reply({ content: "❌ Bạn đã xin nghỉ hôm nay rồi!", ephemeral: true });
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`approve_leave_${interaction.user.id}`).setLabel('Chấp nhận').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`deny_leave_${interaction.user.id}`).setLabel('Từ chối').setStyle(ButtonStyle.Danger)
        );
        if(logLeaveChannel) await logLeaveChannel.send({ content: `📩 **ĐƠN XIN NGHỈ** từ <@${interaction.user.id}>.`, components: [row] });
        return interaction.reply({ content: "Đã gửi đơn xin nghỉ.", ephemeral: true });
    }

    if (interaction.customId.startsWith('approve_leave_') && interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        const targetId = interaction.customId.split('_')[2];
        const today = new Date().toISOString().split('T')[0]; 
        db.run('UPDATE users SET is_on_leave = 1, leave_date = ? WHERE user_id = ?', [today, targetId]);
        saveDatabase();
        try { const u = await client.users.fetch(targetId); await u.send(`✅ Đơn xin nghỉ của bạn đã được duyệt.`); } catch (e) {}
        return interaction.update({ content: `✅ Đã duyệt đơn cho <@${targetId}>.`, components: [] });
    }

    if (interaction.customId.startsWith('deny_leave_') && interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        const targetId = interaction.customId.split('_')[2];
        try { const u = await client.users.fetch(targetId); await u.send(`❌ Đơn xin nghỉ của bạn đã bị từ chối.`); } catch (e) {}
        return interaction.update({ content: `❌ Đã từ chối đơn của <@${targetId}>.`, components: [] });
    }

    if (interaction.customId !== 'onduty_btn' && interaction.customId !== 'offduty_btn') return;

    const user = getOrCreateUser(interaction.user.id);
    const voiceChannel = interaction.member.voice.channel;

    if (interaction.customId === 'onduty_btn') {
        if (user.is_on_leave === 1) return interaction.reply({ content: "❌ Đang nghỉ phép, không thể On Duty!", ephemeral: true });
        if (user.is_on_duty) return interaction.reply({ content: "Bạn đã On Duty rồi!", ephemeral: true });
        if (!voiceChannel) return interaction.reply({ content: "Vào Voice Channel trước đã!", ephemeral: true });

        checkAndAddDay(user.user_id);
        db.run('UPDATE users SET is_on_duty = 1, start_time = ? WHERE user_id = ?', [Date.now(), user.user_id]);
        saveDatabase();
        await interaction.reply({ content: `Bắt đầu ca trực lúc ${new Date().toLocaleTimeString('vi-VN')}.`, ephemeral: true });
        if (logDutyChannel) await logDutyChannel.send({ embeds: [new EmbedBuilder().setTitle('🟢 Bắt đầu ca trực').setDescription(`**Thành viên:** <@${interaction.user.id}>`).setColor(0x00FF00)] });
        updateDutyBoard(interaction.channel);

    } else if (interaction.customId === 'offduty_btn') {
        if (!user.is_on_duty) return interaction.reply({ content: "Bạn chưa On Duty!", ephemeral: true });
        const sessionTime = Date.now() - user.start_time;
        const newTotal = user.total_time + sessionTime;
        db.run('UPDATE users SET is_on_duty = 0, start_time = 0, total_time = ? WHERE user_id = ?', [newTotal, user.user_id]);
        saveDatabase();
        await interaction.reply({ content: `Đã kết thúc ca. Ca này: **${formatTime(sessionTime)}**`, ephemeral: true });
        if (logDutyChannel) await logDutyChannel.send({ embeds: [new EmbedBuilder().setTitle('🔴 Kết thúc ca trực').setDescription(`**Thành viên:** <@${interaction.user.id}>\n**Ca này:** ${formatTime(sessionTime)}`).setColor(0xFF0000)] });
        updateDutyBoard(interaction.channel);
    }
});

client.on(Events.MessageCreate, async message => {
    if (message.author.bot || !isDbReady) return;

    if (message.content === '!setup' && message.member.permissions.has(PermissionFlagsBits.Administrator)) {
        await message.delete().catch(() => {});
        updateDutyBoard(message.channel);
    }

    if (message.content.startsWith('!settime') && message.member.permissions.has(PermissionFlagsBits.Administrator)) {
        const args = message.content.split(' ');
        if (args.length !== 4) return message.reply("Cú pháp: `!settime @User 14:00 15:30`");
        const targetUser = message.mentions.users.first();
        if (!targetUser) return message.reply("Tag tên user vào!");
        const [startTime, endTime] = [args[2], args[3]];
        if (!startTime.includes(':') || !endTime.includes(':')) return message.reply("Giờ phải dạng HH:MM!");
        getOrCreateUser(targetUser.id);
        db.run('UPDATE users SET schedule_start = ?, schedule_end = ?, has_warned_schedule = 0 WHERE user_id = ?', [startTime, endTime, targetUser.id]);
        saveDatabase();
        message.reply(`✅ Đã set lịch cho <@${targetUser.id}>.`);
    }

    if (message.content === '!bxh') {
        const stmt = db.prepare('SELECT * FROM users ORDER BY total_time DESC LIMIT 10');
        const users = []; while (stmt.step()) users.push(stmt.getAsObject()); stmt.free();
        if (users.length === 0) return message.reply("Chưa có dữ liệu.");
        let desc = ""; let rank = 1;
        for (const u of users) {
            const m = await message.guild.members.fetch(u.user_id).catch(() => null);
            let time = u.total_time; if (u.is_on_duty) time += (Date.now() - u.start_time);
            desc += `${rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : `#${rank}`} **${m ? m.displayName : "Unknown"}**\n└ ⏱️ **${formatTime(time)}** | 📅 **${u.total_days} ngày**\n\n`;
            rank++;
        }
        message.reply({ embeds: [new EmbedBuilder().setTitle("🏆 BXH CHĂM CHỈ").setDescription(desc).setColor(0xFFD700)] });
    }

    if (message.content === '!stats') {
        const stmt = db.prepare('SELECT * FROM users');
        const users = []; while (stmt.step()) users.push(stmt.getAsObject()); stmt.free();
        let tM = users.length, tD = 0, tT = 0, oC = 0;
        for (const u of users) { tD += u.total_days; if (u.is_on_duty) { oC++; tT += (u.total_time + (Date.now() - u.start_time)); } else tT += u.total_time; }
        message.reply({ embeds: [new EmbedBuilder().setTitle("📊 THỐNG KÊ").addFields(
            { name: '👥 Nhân sự', value: `\`${tM}\``, inline: true }, { name: '🟢 Online', value: `\`${oC}\``, inline: true },
            { name: '📅 Tổng ngày', value: `\`${tD}\``, inline: true }, { name: '⏱️ Tổng giờ', value: `\`${formatTime(tT)}\``, inline: true }
        ).setColor(0x00BFFF)] });
    }
});

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
    if (!isDbReady) return;
    const user = getOrCreateUser(oldState.id);
    if (user.is_on_duty && oldState.channelId && !newState.channelId && user.is_on_leave !== 1) {
        const sT = Date.now() - user.start_time;
        db.run('UPDATE users SET is_on_duty = 0, start_time = 0, total_time = total_time + ? WHERE user_id = ?', [sT, oldState.id]);
        saveDatabase();
        const wC = client.channels.cache.get(LOG_WARNING_ID);
        if (wC) wC.send(`⚠️ **CẢNH BÁO:** <@${oldState.id}> tự động Off Duty do rớt mạng!`);
    }
});

setInterval(() => {
    if (!isDbReady) return;
    const now = new Date(); const cM = now.getHours() * 60 + now.getMinutes();
    client.guilds.cache.forEach(g => {
        const c = DUTY_BOARD_CHANNEL_ID ? g.channels.cache.get(DUTY_BOARD_CHANNEL_ID) : g.channels.cache.find(x => x.name.includes('chấm-công') || x.name.includes('duty-list'));
        if (c) updateDutyBoard(c);
    });
    const stmt = db.prepare('SELECT * FROM users WHERE schedule_start IS NOT NULL');
    const users = []; while (stmt.step()) users.push(stmt.getAsObject()); stmt.free();
    const wC = client.channels.cache.get(LOG_WARNING_ID);
    for (let u of users) {
        u = checkLeaveStatus(u); if (!u.schedule_start || !u.schedule_end) continue;
        const sM = timeToMinutes(u.schedule_start), eM = timeToMinutes(u.schedule_end);
        if (cM >= sM && cM <= eM && u.is_on_duty === 0 && u.has_warned_schedule === 0 && u.is_on_leave === 0) {
            if (wC) wC.send(`🚨 **NHẮC NHỞ:** <@${u.user_id}> đến giờ trực nhưng chưa On Duty!`);
            db.run('UPDATE users SET has_warned_schedule = 1 WHERE user_id = ?', [u.user_id]); saveDatabase();
        }
        if (cM > eM && u.has_warned_schedule === 1) { db.run('UPDATE users SET has_warned_schedule = 0 WHERE user_id = ?', [u.user_id]); saveDatabase(); }
    }
}, 60000);

async function updateDutyBoard(channel) {
    if (!isDbReady) return;
    try {
        const stmt = db.prepare('SELECT * FROM users'); const users = []; while (stmt.step()) users.push(stmt.getAsObject()); stmt.free();
        let desc = "```\nMEMBER            STATUS     TOTAL TIME\n---------------------------------------\n";
        for (let u of users) {
            u = checkLeaveStatus(u); const m = await channel.guild.members.fetch(u.user_id).catch(() => null); if (!m) continue;
            let st = u.is_on_leave ? "🛌 ON LEAVE" : (u.is_on_duty ? "🟢 ON DUTY " : "🔴 OFFLINE ");
            let tm = formatTime(u.total_time); if (u.is_on_duty) tm = formatTime(u.total_time + (Date.now() - u.start_time)) + " (Live)";
            desc += `${m.displayName.padEnd(18).substring(0, 18)} ${st} ${tm}\n`;
        }
        desc += "```";
        const embed = new EmbedBuilder().setTitle("BẢNG CHẤM CÔNG").setDescription(desc).setColor(0x2b2d31).setFooter({ text: `Cập nhật: ${new Date().toLocaleTimeString('vi-VN')}` });
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('onduty_btn').setLabel('On Duty').setStyle(ButtonStyle.Success).setEmoji('🟢'),
            new ButtonBuilder().setCustomId('offduty_btn').setLabel('Off Duty').setStyle(ButtonStyle.Danger).setEmoji('🔴'),
            new ButtonBuilder().setCustomId('leave_btn').setLabel('Xin Nghỉ').setStyle(ButtonStyle.Secondary).setEmoji('🛌')
        );
        const msgs = await channel.messages.fetch({ limit: 10 }); const bM = msgs.find(x => x.author.id === client.user.id && x.embeds.length > 0 && x.components.length > 0);
        if (bM) await bM.edit({ embeds: [embed], components: [row] }); else await channel.send({ embeds: [embed], components: [row] });
    } catch (e) {}
}

const app = express(); const PORT = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('Bot online!'));
app.listen(PORT, () => console.log(`Web server chạy cổng ${PORT}`));

if (!TOKEN) { console.error("❌ CHƯA CÓ TOKEN TRÊN RENDER!"); } 
else { client.login(TOKEN).catch(e => console.error("❌ LỖI LOGIN (Sai Token/Thiếu Intent):", e.message)); }
