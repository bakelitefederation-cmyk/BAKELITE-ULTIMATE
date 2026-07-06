const { Telegraf, Markup } = require('telegraf');

// Инициализация бота через переменную окружения (как на Railway)
const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

const BOT_VERSION = "v1.0.0-Beta";

// Имитация базы данных (In-Memory). Для продакшена заменить на реальную БД.
const db = {
    users: {},     // Хранилище текущих состояний пользователей (FSM)
    reports: {},   // Все заявки на помощь: { userId: { status: 'pending'|'accepted'|'declined', data: {...} } }
    defenders: {}, // Заявки на вступление: { userId: { status: 'pending', data: {...} } }
    stats: { accepted: 0, declined: 0 } // Общая статистика
};

// --- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ И КНОПКИ ---

const getMainMenuKeyboard = () => {
    return Markup.inlineKeyboard([
        [Markup.button.callback('🛡️ Стать защитником', 'cmd_join')],
        [Markup.button.callback('🆘 Запросить помощь', 'cmd_report')],
        [Markup.button.callback('📊 Статус моей заявки', 'cmd_status')],
        [Markup.button.callback('ℹ️ Справка', 'cmd_help')]
    ]);
};

const getBackMenuKeyboard = () => {
    return Markup.inlineKeyboard([
        [Markup.button.callback('⬅️ Вернуться в меню', 'cmd_menu')]
    ]);
};

// Сброс состояния пользователя
const resetState = (userId) => {
    if (db.users[userId]) {
        db.users[userId].state = null;
        db.users[userId].step = null;
    }
};

// --- ОСНОВНЫЕ КОМАНДЫ ---

// /start и /menu
const sendWelcome = async (ctx) => {
    const userId = ctx.from.id;
    resetState(userId);
    
    const text = `Приветствуем в системе реагирования на киберпреступность *«Bakelite Defence»*!\n\n` +
                 `Я — автоматизированный бот-помощник.\n` +
                 `Версия системы: \`${BOT_VERSION}\`\n\n` +
                 `Выберите необходимое действие ниже:`;
                 
    await ctx.replyWithMarkdownV2(text.replace(/[-.\!]/g, '\\$&'), getMainMenuKeyboard());
};

bot.start(sendWelcome);
bot.action('cmd_menu', sendWelcome);
bot.command('menu', sendWelcome);

// /help - Справка
const sendHelp = async (ctx) => {
    const text = `📌 *Справка по командам бота:*\n\n` +
                 `/start \\| /menu — Главное меню системы\n` +
                 `/join — Подать заявку в команду защитников \\(OSINT\\)\n` +
                 `/report — Сообщить о киберпреступлении и получить помощь\n` +
                 `/status — Проверить статус ваших обращений и общую статистику`;
    await ctx.replyWithMarkdownV2(text, getBackMenuKeyboard());
};
bot.command('help', sendHelp);
bot.action('cmd_help', sendHelp);

// --- ЛОГИКА /STATUS ---
const sendStatus = async (ctx) => {
    const userId = ctx.from.id;
    const userReport = db.reports[userId];
    
    let reportStatusText = "У вас нет активных заявок на помощь\\.";
    if (userReport) {
        let statusEmoji = "⏳";
        let statusString = "Под рассмотрением";
        if (userReport.status === 'accepted') { statusEmoji = "✅"; statusString = "Принята в работу"; }
        if (userReport.status === 'declined') { statusEmoji = "❌"; statusString = "Отклонена"; }
        reportStatusText = `Статус вашей заявки: ${statusEmoji} *${statusString}*`;
    }

    const text = `📊 *Статистика системы:* \n` +
                 `• Принято заявок в работу: ${db.stats.accepted}\n` +
                 `• Отклонено заявок: ${db.stats.declined}\n\n` +
                 `🔍 *Ваш статус:* \n${reportStatusText}\n\n` +
                 `_Примечание: При завершении работы по заявке, защитник свяжется с вами напрямую в ЛС\\._`;
                 
    await ctx.replyWithMarkdownV2(text, getBackMenuKeyboard());
};
bot.command('status', sendStatus);
bot.action('cmd_status', sendStatus);


// --- ЛОГИКА /JOIN (СТАТЬ ЗАЩИТНИКОМ) ---
bot.command('join', async (ctx) => { ctx.reply('Нажимайте кнопку в меню для запуска процесса.'); });

bot.action('cmd_join', async (ctx) => {
    const userId = ctx.from.id;
    db.users[userId] = { state: 'JOIN_FLOW', step: 'SELECT_REGION', data: {} };
    
    await ctx.reply('Шаг 1: Выберите ваш регион деятельности:', Markup.inlineKeyboard([
        [Markup.button.callback('Россия', 'join_reg_RU'), Markup.button.callback('Украина', 'join_reg_UA')],
        [Markup.button.callback('Казахстан', 'join_reg_KZ'), Markup.button.callback('Другое', 'join_reg_OTHER')],
        [Markup.button.callback('⬅️ Отмена', 'cmd_menu')]
    ]));
});

// Обработка выбора региона для /join
bot.action(/^join_reg_(.+)$/, async (ctx) => {
    const userId = ctx.from.id;
    if (!db.users[userId] || db.users[userId].state !== 'JOIN_FLOW') return;
    
    const regions = { 'RU': 'Россия', 'UA': 'Украина', 'KZ': 'Казахстан', 'OTHER': 'Другой регион' };
    db.users[userId].data.region = regions[ctx.match[1]];
    
    db.users[userId].step = 'INPUT_NICKNAME';
    await ctx.reply('Шаг 2: Введите ваш рабочий Псевдоним (Никнейм) для системы:');
});


// --- ЛОГИКА /REPORT (ЗАПРОСИТЬ ПОМОЩЬ) ---
bot.command('report', async (ctx) => { ctx.reply('Пожалуйста, используйте меню бота для отправки репорта.'); });

bot.action('cmd_report', async (ctx) => {
    const userId = ctx.from.id;
    db.users[userId] = { state: 'REPORT_FLOW', step: 'SELECT_REGION', data: {} };
    
    await ctx.reply('Шаг 1: В какой стране/регионе произошел инцидент?', Markup.inlineKeyboard([
        [Markup.button.callback('Россия', 'rep_reg_RU'), Markup.button.callback('Украина', 'rep_reg_UA')],
        [Markup.button.callback('Казахстан', 'rep_reg_KZ'), Markup.button.callback('Другое', 'rep_reg_OTHER')],
        [Markup.button.callback('⬅️ Отмена', 'cmd_menu')]
    ]));
});

// Обработка региона для репорта
bot.action(/^rep_reg_(.+)$/, async (ctx) => {
    const userId = ctx.from.id;
    if (!db.users[userId] || db.users[userId].state !== 'REPORT_FLOW') return;
    
    if (ctx.match[1] === 'OTHER') {
        db.users[userId].step = 'INPUT_OTHER_REGION';
        await ctx.reply('Напишите, в какой стране произошел инцидент:');
    } else {
        const regions = { 'RU': 'Россия', 'UA': 'Украина', 'KZ': 'Казахстан' };
        db.users[userId].data.region = regions[ctx.match[1]];
        goToReportType(ctx, userId);
    }
});

const goToReportType = async (ctx, userId) => {
    db.users[userId].step = 'SELECT_TYPE';
    await ctx.reply('Шаг 2: Выберите вид киберпреступности:', Markup.inlineKeyboard([
        [Markup.button.callback('Вымогательство', 'rep_type_1'), Markup.button.callback('Кибербуллинг', 'rep_type_2')],
        [Markup.button.callback('Мошенничество', 'rep_type_3'), Markup.button.callback('Другое', 'rep_type_OTHER')],
        [Markup.button.callback('⬅️ Отмена', 'cmd_menu')]
    ]));
};

// Обработка типа преступления
bot.action(/^rep_type_(.+)$/, async (ctx) => {
    const userId = ctx.from.id;
    if (!db.users[userId] || db.users[userId].state !== 'REPORT_FLOW') return;
    
    if (ctx.match[1] === 'OTHER') {
        db.users[userId].step = 'INPUT_OTHER_TYPE';
        await ctx.reply('Укажите ваш вид киберпреступности:');
    } else {
        const types = { '1': 'Вымогательство', '2': 'Кибербуллинг', '3': 'Мошенничество' };
        db.users[userId].data.type = types[ctx.match[1]];
        goToReportDescription(ctx, userId);
    }
});

const goToReportDescription = async (ctx, userId) => {
    db.users[userId].step = 'INPUT_DESCRIPTION';
    await ctx.reply('Шаг 3: Предоставьте подробное описание проблемы (ссылки, детали, суть обмана):');
};


// --- ТЕКСТОВЫЙ МЕНЕДЖЕР (ВВОД ДАННЫХ ПОЛЬЗОВАТЕЛЕМ) ---
bot.on('text', async (ctx) => {
    const userId = ctx.from.id;
    const userSession = db.users[userId];
    
    if (!userSession) return;
    
    // Ввод для Защитников (/join)
    if (userSession.state === 'JOIN_FLOW') {
        if (userSession.step === 'INPUT_NICKNAME') {
            userSession.data.nickname = ctx.message.text;
            userSession.step = 'INPUT_SPECIALTY';
            await ctx.reply('Шаг 3: Укажите вашу специальность/навыки (кем вы являетесь в сфере IT/OSINT):');
            return;
        }
        if (userSession.step === 'INPUT_SPECIALTY') {
            userSession.data.specialty = ctx.message.text;
            userSession.step = 'CONFIRM';
            
            const summary = `📋 *Резюме кандидата:*\n\n` +
                            `• Регион: ${userSession.data.region}\n` +
                            `• Никнейм: ${userSession.data.nickname}\n` +
                            `• Специальность: ${userSession.data.specialty}`;
            
            await ctx.replyWithMarkdownV2(summary.replace(/[-.\!]/g, '\\$&'), Markup.inlineKeyboard([
                [Markup.button.callback('✅ Отправить заявку', 'join_confirm_send')],
                [Markup.button.callback('❌ Отменить', 'cmd_menu')]
            ]));
            return;
        }
    }
    
    // Ввод для Пострадавших (/report)
    if (userSession.state === 'REPORT_FLOW') {
        if (userSession.step === 'INPUT_OTHER_REGION') {
            userSession.data.region = ctx.message.text;
            goToReportType(ctx, userId);
            return;
        }
        if (userSession.step === 'INPUT_OTHER_TYPE') {
            userSession.data.type = ctx.message.text;
            goToReportDescription(ctx, userId);
            return;
        }
        if (userSession.step === 'INPUT_DESCRIPTION') {
            userSession.data.description = ctx.message.text;
            userSession.step = 'CONFIRM';
            
            const summary = `🚨 *Проверка репорта перед отправкой:*\n\n` +
                            `• Регион инцидента: ${userSession.data.region}\n` +
                            `• Вид нарушения: ${userSession.data.type}\n` +
                            `• Описание: ${userSession.data.description}`;
                            
            await ctx.replyWithMarkdownV2(summary.replace(/[-.\!]/g, '\\$&'), Markup.inlineKeyboard([
                [Markup.button.callback('✅ Всё верно, отправить', 'rep_confirm_send')],
                [Markup.button.callback('❌ Отменить', 'cmd_menu')]
            ]));
            return;
        }
    }
});


// --- ОБРАБОТКА ФИНАЛЬНЫХ ПОДТВЕРЖДЕНИЙ ---

// Подтверждение отправки заявки на Защитника -> Админу
bot.action('join_confirm_send', async (ctx) => {
    const userId = ctx.from.id;
    const userSession = db.users[userId];
    if (!userSession || userSession.state !== 'JOIN_FLOW') return;
    
    db.defenders[userId] = { status: 'pending', data: userSession.data, username: ctx.from.username || 'нету' };
    
    // Уведомление пользователю
    await ctx.reply('🚀 Ваша заявка успешно отправлена администрации проекта! Ожидайте верификации.', getBackMenuKeyboard());
    
    // Отправка в админ-чат
    if (ADMIN_CHAT_ID) {
        const adminText = `🔔 *НОВАЯ ЗАЯВКА НА ВСТУПЛЕНИЕ (Защитник)*\n\n` +
                          `• От: [Ссылка](tg://user?id=${userId}) (ID: \`${userId}\`, @${ctx.from.username || 'нет'})\n` +
                          `• Регион: ${userSession.data.region}\n` +
                          `• Псевдоним: ${userSession.data.nickname}\n` +
                          `• Специальность: ${userSession.data.specialty}`;
                          
        await bot.telegram.sendMessage(ADMIN_CHAT_ID, adminText.replace(/[-.]/g, '\\$&'), {
            parse_mode: 'MarkdownV2',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('👍 Одобрить', `adm_join_accept_${userId}`), Markup.button.callback('👎 Отклонить', `adm_join_decline_${userId}`)]
            ])
        });
    }
    resetState(userId);
});

// Подтверждение отправки Репорта -> Публичное распределение Защитникам
bot.action('rep_confirm_send', async (ctx) => {
    const userId = ctx.from.id;
    const userSession = db.users[userId];
    if (!userSession || userSession.state !== 'REPORT_FLOW') return;
    
    db.reports[userId] = { status: 'pending', data: userSession.data };
    
    await ctx.reply('✅ Ваш запрос о помощи зарегистрирован в системе. Когда специалист возьмет его в работу, вы получите мгновенное уведомление.', getBackMenuKeyboard());
    
    // Рассылка Защитникам/В Админку (так как в ТЗ указано: "При отправлении заявки защитнику любого региона придет уведомление")
    if (ADMIN_CHAT_ID) {
        const reportText = `🚨 *НОВЫЙ ЗАПРОС О ПОМОЩИ*\n\n` +
                           `• ID пострадавшего: \`${userId}\`\n` +
                           `• Регион: ${userSession.data.region}\n` +
                           `• Тип киберпреступления: ${userSession.data.type}\n` +
                           `• Описание: ${userSession.data.description}`;
                           
        await bot.telegram.sendMessage(ADMIN_CHAT_ID, reportText.replace(/[-.]/g, '\\$&'), {
            parse_mode: 'MarkdownV2',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('⚡ Взять в работу', `def_rep_take_${userId}`)],
                [Markup.button.callback('❌ Отклонить репорт', `def_rep_deny_${userId}`)]
            ])
        });
    }
    resetState(userId);
});


// --- ДЕЙСТВИЯ АДМИНИСТРАТОРОВ И ЗАЩИТНИКОВ ---

// Модерация заявок Защитников (Одобрить/Отклонить)
bot.action(/^adm_join_accept_(.+)$/, async (ctx) => {
    const targetUserId = ctx.match[1];
    if (db.defenders[targetUserId]) db.defenders[targetUserId].status = 'accepted';
    
    await ctx.editMessageText(`${ctx.effectiveMessage.text}\n\n🟢 Статус: ОДОБРЕН`);
    await bot.telegram.sendMessage(targetUserId, `🎉 Поздравляем! Ваша заявка одобрена. Добро пожаловать в команду Bakelite Defence!`);
});

bot.action(/^adm_join_decline_(.+)$/, async (ctx) => {
    const targetUserId = ctx.match[1];
    if (db.defenders[targetUserId]) db.defenders[targetUserId].status = 'declined';
    
    await ctx.editMessageText(`${ctx.effectiveMessage.text}\n\n🔴 Статус: ОТКЛОНЕН`);
    await bot.telegram.sendMessage(targetUserId, `❌ К сожалению, ваша заявка на вступление отклонена модератором.`);
});

// Работа Защитников с репортами (Взять/Отклонить)
bot.action(/^def_rep_take_(.+)$/, async (ctx) => {
    const targetUserId = ctx.match[1];
    const defender
