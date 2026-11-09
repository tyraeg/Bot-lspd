const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, Events, PermissionFlagsBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const initSqlJs = require('sql.js');
const fs = require('fs');
const express = require('express');

// ==========================================
// ĐỌC CẤU HÌNH TỪ BIẾN MÔI TRƯỜNG (ENVIRONMENT VARIABLES)
// Khi chạy trên Render, bạn sẽ điền các giá trị này ở tab Environment.
// Nếu chạy dưới máy (Termux), bạn có thể điền trực tiếp vào sau dấu ||.
// ==========================================
const TOKEN = process.env.TOKEN || 'DÁN_TOKEN_NEU_CHAY_LOCAL';
const CLIENT_ID = process.env.CLIENT_ID || 'DÁN_CLIENT_ID_NEU_CHAY_LOCAL';

const LOG_DUTY_ID = process.env.LOG_DUTY_ID || 'DÁN_ID_KÊNH_LOG_ON_OFF';
const LOG_WARNING_ID = process.env.LOG_WARNING_ID || 'DÁN_ID_KÊNH_CANH_BAO';
const LOG_LEAVE_ID = process.env.LOG_LEAVE_ID || 'DÁN_ID_KÊNH_XIN_NGHI';

const DUTY_BOARD_CHANNEL_ID = process.env.DUTY_BOARD_CHANNEL_ID || ''; 
// ==========================================

let db;

async function initDatabase() {
    const SQL = await initSqlJs();
    if (fs.existsSync('duty.db')) {
        const filebuffer = fs.readFileSync('duty.db');
        db = new SQL.Database(filebuffer);
    } else {
        db = new SQL.Database();
    }
    
    db.run(`CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY,
        is_on_duty INTEGER DEFAULT 0,
        start_time INTEGER DEFAULT 0,
        total_time INTEGER DEFAULT 0,
        total_days INTEGER DEFAULT 0,
        is_on_leave INTEGER DEFAULT 0,
        leave_date TEXT DEFAULT NULL,
        schedule_start TEXT DEFAULT NULL,
        schedule_end TEXT DEFAULT NULL,
        has_warned_schedule INTEGER DEFAULT 0
    )`);
    
    try { db.run('ALTER TABLE users ADD COLUMN total_days INTEGER DEFAULT 0'); } catch (e) {}
    try { db.run('ALTER TABLE users ADD COLUMN is_on_leave INTEGER DEFAULT 0'); } catch (e) {}
    try { db.run('ALTER TABLE users ADD COLUMN leave_date TEXT DEFAULT NULL'); } catch (e) {}
    try { db.run('ALTER TABLE users ADD COLUMN schedule_start TEXT DEFAULT NULL'); } catch (e) {}
    try { db.run('ALTER TABLE users ADD COLUMN schedule_end TEXT DEFAULT NULL'); } catch (e) {}
    try { db.run('ALTER TABLE users ADD COLUMN has_warned_schedule INTEGER DEFAULT 0'); } catch (e) {}

    try {
        db.run(`CREATE TABLE IF NOT EXISTS history (user_id TEXT, date TEXT, PRIMARY KEY (user_id, date))`);
    } catch (e) {}
    
    saveDatabase();
}

function saveDatabase() {
    const data = db.export();
    fs.writeFileSync('duty.db', Buffer.from(data));
}

function checkAndAddDay(userId) {
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
    const stmt = db.prepare('SELECT * FROM users WHERE user_id = ?');
    stmt.bind([userId]);
    let user = null;
    if (stmt.step()) user = stmt.getAsObject();
    stmt.free();

    if (!user) {
        db.run('INSERT INTO users (user_id) VALUES (?)', [userId]);
        saveDatabase();
        user = { user_id: userId, is_on_duty: 0, start_time: 0, total_time: 0, total_days: 0, is_on_leave: 0, leave_date: null };
    } else {
        user = checkLeaveStatus(user);
    }
    return user;
};

const formatTime = (ms) => {
    if (!ms || ms < 1000) return "0 Giây";
    const totalSeconds = Math.floor(ms / 1000);
    if (totalSeconds < 60) return `${totalSeconds} Giây`;
    const totalMinutes = Math.floor(totalSeconds / 60);
    if (totalMinutes < 60) return `${totalMinutes} Phút`;
    const totalHours = Math.floor(totalMinutes / 60);
    return `${totalHours} Giờ`;
};

const timeToMinutes = (timeStr) => {
    const [h, m] = timeStr.split(':').map(Number);
    return h * 60 + m;
};

// --- TẠO CÁC LỆNH SLASH COMMAND ---
const commands = [
    new SlashCommandBuilder()
        .setName('settime')
        .setDescription('Cài đặt lịch trực cho nhân viên')
        .addUserOption(opt => opt.setName('user').setDescription('Chọn nhân viên').setRequired(true))
        .addStringOption(opt => opt.setName('start').setDescription('Giờ bắt đầu (VD: 14:00)').setRequired(true))
        .addStringOption(opt => opt.setName('end').setDescription('Giờ kết thúc (VD: 15:30)').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName('setup')
        .setDescription('Tạo bảng chấm công')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName('bxh')
        .setDescription('Xem bảng xếp hạng chăm chỉ'),

    new SlashCommandBuilder()
        .setName('stats')
        .setDescription('Xem thống kê chung của server')
].map(command => command.toJSON());

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages
    ]
});

client.once(Events.ClientReady, async () => {
    console.log(`Bot đã sẵn sàng: ${client.user.tag}`);
    
    try {
        const rest = new REST({ version: '10' }).setToken(TOKEN);
        await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
        console.log('Đã đăng ký thành công các lệnh Slash Command!');
    } catch (error) {
        console.error('Lỗi đăng ký lệnh:', error);
    }
});

// --- BẢNG ĐIỂM DANH ---
async function updateDutyBoard(channel) {
    try {
        const stmt = db.prepare('SELECT * FROM users');
        const users = [];
        while (stmt.step()) users.push(stmt.getAsObject());
        stmt.free();

        const guild = channel.guild;
        let description = "```\n";
        description += "MEMBER            STATUS     TOTAL TIME\n";
        description += "---------------------------------------\n";

        for (let u of users) {
            u = checkLeaveStatus(u); 
            const member = await guild.members.fetch(u.user_id).catch(() => null);
            if (!member) continue;

            const name = member.displayName.padEnd(18).substring(0, 18);
            let status = "🔴 OFFLINE ";
            if (u.is_on_leave) status = "🛌 ON LEAVE";
            else if (u.is_on_duty) status = "🟢 ON DUTY ";
            
            let time = formatTime(u.total_time);
            if (u.is_on_duty) time = formatTime(u.total_time + (Date.now() - u.start_time)) + " (Live)";

            description += `${name} ${status} ${time}\n`;
        }
        description += "```";

        const embed = new EmbedBuilder()
            .setTitle("BẢNG CHẤM CÔNG (DUTY LIST)")
            .setDescription(description)
            .setColor(0x2b2d31)
            .setFooter({ text: `Cập nhật lúc: ${new Date().toLocaleTimeString('vi-VN')}` });

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('onduty_btn').setLabel('On Duty').setStyle(ButtonStyle.Success).setEmoji('🟢'),
            new ButtonBuilder().setCustomId('offduty_btn').setLabel('Off Duty').setStyle(ButtonStyle.Danger).setEmoji('🔴'),
            new ButtonBuilder().setCustomId('leave_btn').setLabel('Xin Nghỉ').setStyle(ButtonStyle.Secondary).setEmoji('🛌')
        );

        const messages = await channel.messages.fetch({ limit: 10 });
        const botMessage = messages.find(m => m.author.id === client.user.id && m.embeds.length > 0 && m.components.length > 0);

        if (botMessage) await botMessage.edit({ embeds: [embed], components: [row] });
        else await channel.send({ embeds: [embed], components: [row] });
    } catch (error) {}
}

// --- XỬ LÝ TƯƠNG TÁC ---
client.on(Events.InteractionCreate, async interaction => {
    const logDutyChannel = client.channels.cache.get(LOG_DUTY_ID);
    const logLeaveChannel = client.channels.cache.get(LOG_LEAVE_ID);

    if (interaction.isChatInputCommand()) {
        const { commandName, options, guild } = interaction;

        if (commandName === 'setup') {
            await interaction.deferReply({ ephemeral: true });
            await interaction.channel.send({ content: "Đang khởi tạo bảng..." }).then(async msg => {
                await msg.delete();
                await updateDutyBoard(interaction.channel);
            });
            return interaction.editReply({ content: "✅ Đã tạo bảng chấm công!" });
        }

        if (commandName === 'settime') {
            const targetUser = options.getUser('user');
            const startTime = options.getString('start');
            const endTime = options.getString('end');

            if (!startTime.includes(':') || !endTime.includes(':')) {
                return interaction.reply({ content: "Giờ phải có định dạng HH:MM (Ví dụ: 14:00).", ephemeral: true });
            }

            getOrCreateUser(targetUser.id);
            db.run('UPDATE users SET schedule_start = ?, schedule_end = ?, has_warned_schedule = 0 WHERE user_id = ?', [startTime, endTime, targetUser.id]);
            saveDatabase();
            return interaction.reply({ content: `✅ Đã set lịch cho <@${targetUser.id}>: Từ **${startTime}** đến **${endTime}**.` });
        }

        if (commandName === 'bxh') {
            await interaction.deferReply();
            const stmt = db.prepare('SELECT * FROM users ORDER BY total_time DESC LIMIT 10');
            const users = [];
            while (stmt.step()) users.push(stmt.getAsObject());
            stmt.free();

            if (users.length === 0) return interaction.editReply("Chưa có dữ liệu trực.");

            let description = "";
            let rank = 1;
            for (const u of users) {
                const target = await guild.members.fetch(u.user_id).catch(() => null);
                const name = target ? target.displayName : "Unknown";
                const medal = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : `#${rank}`;
                
                let time = u.total_time;
                if (u.is_on_duty) time += (Date.now() - u.start_time);

                description += `${medal} **${name}**\n`;
                description += `└ ⏱️ Tổng: **${formatTime(time)}** | 📅 Ngày: **${u.total_days}**\n\n`;
                rank++;
            }

            const embed = new EmbedBuilder().setTitle("🏆 BẢNG XẾP HẠNG CHĂM CHỈ").setDescription(description).setColor(0xFFD700);
            return interaction.editReply({ embeds: [embed] });
        }

        if (commandName === 'stats') {
            await interaction.deferReply();
            const stmt = db.prepare('SELECT * FROM users');
            const users = [];
            while (stmt.step()) users.push(stmt.getAsObject());
            stmt.free();

            let totalMembers = users.length;
            let totalDays = 0;
            let totalTime = 0;
            let onlineCount = 0;

            for (const u of users) {
                totalDays += u.total_days;
                if (u.is_on_duty) {
                    onlineCount++;
                    totalTime += (u.total_time + (Date.now() - u.start_time));
                } else {
                    totalTime += u.total_time;
                }
            }

            const embed = new EmbedBuilder().setTitle("📊 THỐNG KÊ CHUNG SERVER").addFields(
                { name: '👥 Tổng nhân sự', value: `\`${totalMembers}\` người`, inline: true },
                { name: '🟢 Đang Online', value: `\`${onlineCount}\` người`, inline: true },
                { name: '📅 Tổng ngày trực', value: `\`${totalDays}\` ngày`, inline: true },
                { name: '⏱️ Tổng thời gian', value: `\`${formatTime(totalTime)}\``, inline: true }
            ).setColor(0x00BFFF);
            return interaction.editReply({ embeds: [embed] });
        }
    }

    if (interaction.isButton()) {
        if (interaction.customId === 'leave_btn') {
            const user = getOrCreateUser(interaction.user.id);
            if (user.is_on_leave === 1) {
                return interaction.reply({ content: "❌ Bạn đã xin nghỉ phép hôm nay rồi. Qua 12h đêm hệ thống sẽ tự động mở khóa!", ephemeral: true });
            }

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`approve_leave_${interaction.user.id}`).setLabel('Chấp nhận').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId(`deny_leave_${interaction.user.id}`).setLabel('Từ chối').setStyle(ButtonStyle.Danger)
            );
            if(logLeaveChannel) {
                await logLeaveChannel.send({ content: `📩 **ĐƠN XIN NGHỈ** từ <@${interaction.user.id}>. Admin duyệt:`, components: [row] });
            }
            return interaction.reply({ content: "Đã gửi đơn xin nghỉ đến Admin.", ephemeral: true });
        }

        if (interaction.customId.startsWith('approve_leave_') && interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
            const targetId = interaction.customId.split('_')[2];
            const today = new Date().toISOString().split('T')[0]; 
            db.run('UPDATE users SET is_on_leave = 1, leave_date = ? WHERE user_id = ?', [today, targetId]);
            saveDatabase();
            
            try {
                const targetUser = await client.users.fetch(targetId);
                await targetUser.send(`✅ **THÔNG BÁO:** Đơn xin nghỉ phép của bạn đã được Admin **${interaction.user.username}** phê duyệt. Hệ thống sẽ tự động mở khóa On Duty vào 00:00 ngày mai.`);
            } catch (error) {}
            return interaction.update({ content: `✅ **${interaction.user.username}** đã duyệt đơn xin nghỉ cho <@${targetId}>.`, components: [] });
        }

        if (interaction.customId.startsWith('deny_leave_') && interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
            const targetId = interaction.customId.split('_')[2];
            try {
                const targetUser = await client.users.fetch(targetId);
                await targetUser.send(`❌ **THÔNG BÁO:** Đơn xin nghỉ phép của bạn đã bị Admin **${interaction.user.username}** từ chối.`);
            } catch (error) {}
            return interaction.update({ content: `❌ **${interaction.user.username}** đã từ chối đơn xin nghỉ của <@${targetId}>.`, components: [] });
        }

        if (interaction.customId !== 'onduty_btn' && interaction.customId !== 'offduty_btn') return;

        const user = getOrCreateUser(interaction.user.id);
        const voiceChannel = interaction.member.voice.channel;

        if (interaction.customId === 'onduty_btn') {
            if (user.is_on_leave === 1) {
                return interaction.reply({ content: "❌ Bạn đang trong thời gian xin nghỉ phép hôm nay. Qua 12h đêm (ngày mai) bạn mới có thể On Duty lại!", ephemeral: true });
            }
            if (user.is_on_duty) return interaction.reply({ content: "Bạn đã trong ca trực rồi!", ephemeral: true });
            if (!voiceChannel) return interaction.reply({ content: "Bạn phải vào Voice Channel trước khi On Duty!", ephemeral: true });

            checkAndAddDay(user.user_id);
            db.run('UPDATE users SET is_on_duty = 1, start_time = ? WHERE user_id = ?', [Date.now(), user.user_id]);
            saveDatabase();
            
            await interaction.reply({ content: `Bắt đầu ca trực lúc ${new Date().toLocaleTimeString('vi-VN')}.`, ephemeral: true });
            if (logDutyChannel) {
                const logEmbed = new EmbedBuilder().setTitle('🟢 Bắt đầu ca trực').setDescription(`**Thành viên:** <@${interaction.user.id}>\n**Giờ:** ${new Date().toLocaleTimeString('vi-VN')}`).setColor(0x00FF00);
                await logDutyChannel.send({ embeds: [logEmbed] });
            }
            updateDutyBoard(interaction.channel);

        } else if (interaction.customId === 'offduty_btn') {
            if (!user.is_on_duty) return interaction.reply({ content: "Bạn chưa On Duty!", ephemeral: true });

            const sessionTime = Date.now() - user.start_time;
            const newTotal = user.total_time + sessionTime;
            db.run('UPDATE users SET is_on_duty = 0, start_time = 0, total_time = ? WHERE user_id = ?', [newTotal, user.user_id]);
            saveDatabase();
            
            await interaction.reply({ content: `Đã kết thúc ca. Ca này: **${formatTime(sessionTime)}**`, ephemeral: true });
            if (logDutyChannel) {
                const logEmbed = new EmbedBuilder().setTitle('🔴 Kết thúc ca trực').setDescription(`**Thành viên:** <@${interaction.user.id}>\n**Ca này:** ${formatTime(sessionTime)}`).setColor(0xFF0000);
                await logDutyChannel.send({ embeds: [logEmbed] });
            }
            updateDutyBoard(interaction.channel);
        }
    }
});

// --- TỰ ĐỘNG OFF KHI RỜI VOICE ---
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
    const userId = oldState.id;
    const user = getOrCreateUser(userId);

    if (user.is_on_duty && oldState.channelId && !newState.channelId && user.is_on_leave !== 1) {
        const sessionTime = Date.now() - user.start_time;
        const newTotal = user.total_time + sessionTime;
        db.run('UPDATE users SET is_on_duty = 0, start_time = 0, total_time = ? WHERE user_id = ?', [newTotal, userId]);
        saveDatabase();

        const warningChannel = client.channels.cache.get(LOG_WARNING_ID);
        if (warningChannel) {
            await warningChannel.send(`⚠️ **CẢNH BÁO:** <@${userId}> đã bị **Off Duty** do mất kết nối/rời Voice!`);
            const warnEmbed = new EmbedBuilder().setTitle('🚨 DISCONNECT KHI ĐANG TRỰC').setDescription(`**Thành viên:** <@${userId}>\n**Ca này:** ${formatTime(sessionTime)}`).setColor(0xFF0000);
            await warningChannel.send({ embeds: [warnEmbed] });
        }
    }
});

// --- BỘ ĐẾM KIỂM TRA LỊCH TRỰC ---
setInterval(() => {
    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    client.guilds.cache.forEach(guild => {
        let channel;
        if (DUTY_BOARD_CHANNEL_ID) {
            channel = guild.channels.cache.get(DUTY_BOARD_CHANNEL_ID);
        } else {
            channel = guild.channels.cache.find(c => c.name.includes('chấm-công') || c.name.includes('duty-list'));
        }
        if (channel) updateDutyBoard(channel);
    });

    const users = [];
    const stmt = db.prepare('SELECT * FROM users WHERE schedule_start IS NOT NULL');
    while (stmt.step()) users.push(stmt.getAsObject());
    stmt.free();

    const logWarningChannel = client.channels.cache.get(LOG_WARNING_ID);

    for (let u of users) {
        u = checkLeaveStatus(u); 
        if (!u.schedule_start || !u.schedule_end) continue;
        
        const startMins = timeToMinutes(u.schedule_start);
        const endMins = timeToMinutes(u.schedule_end);

        if (currentMinutes >= startMins && currentMinutes <= endMins) {
            if (u.is_on_duty === 0 && u.has_warned_schedule === 0 && u.is_on_leave === 0) {
                if (logWarningChannel) {
                    logWarningChannel.send(`🚨 **NHẮC NHỞ:** <@${u.user_id}> đã đến giờ trực (từ **${u.schedule_start}**), nhưng chưa bấm nút **On Duty**!`);
                }
                db.run('UPDATE users SET has_warned_schedule = 1 WHERE user_id = ?', [u.user_id]);
                saveDatabase();
            }
        }
        
        if (currentMinutes > endMins) {
            if (u.has_warned_schedule === 1) {
                db.run('UPDATE users SET has_warned_schedule = 0 WHERE user_id = ?', [u.user_id]);
                saveDatabase();
            }
        }
    }
}, 60 * 1000); 

// ==========================================
// KHỞI TẠO WEB SERVER (DÀNH CHO RENDER)
// ==========================================
const app = express();
const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => {
    res.send('Bot dang hoat dong!');
});

app.listen(PORT, () => {
    console.log(`Web server đang chạy trên cổng ${PORT}`);
});

// KHỞI ĐỘNG BOT
initDatabase().then(() => {
    client.login(TOKEN);
}).catch(console.error);
