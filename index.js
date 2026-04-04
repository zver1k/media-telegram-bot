const { Telegraf, Markup, session } = require('telegraf')
const youtubedl = require('youtube-dl-exec')
const fs = require('fs')
const fsPromises = require('fs/promises')
const path = require('path')
const crypto = require('crypto')
const { execSync } = require('child_process')
require('dotenv').config()

function getVideoDimensions(filePath) {
    try {
        const result = execSync(
            `ffprobe -v quiet -print_format json -show_streams "${filePath}"`,
            { timeout: 5000 }
        )
        const data = JSON.parse(result.toString())
        const videoStream = data.streams.find(s => s.codec_type === 'video')
        if (videoStream) return { width: videoStream.width, height: videoStream.height }
    } catch { }
    return null
}

const bot = new Telegraf(process.env.BOT_TOKEN, {
    telegram: {
        apiRoot: process.env.TG_API_BASE_URL || 'https://api.telegram.org'
    }
})

bot.use(session())

const tmpDir = path.join(__dirname, 'tmp')

if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir)
}

const activeDownloads = new Map()
const cooldown = new Map()

// очистка временных файлов и кэша в памяти
setInterval(async () => {

    // 1. Очистка старых файлов в папке tmp
    try {
        const files = await fsPromises.readdir(tmpDir)

        for (const file of files) {
            const filePath = path.join(tmpDir, file)
            const stat = await fsPromises.stat(filePath)

            const age = Date.now() - stat.mtimeMs
            if (age > 3600000) { // 1 час
                await fsPromises.unlink(filePath).catch(() => { })
            }
        }
    } catch (err) {
        console.error("Ошибка при очистке tmp:", err.message)
    }

    // 2. Очистка cooldown для защиты от утечки памяти
    const now = Date.now()
    for (const [userId, lastTime] of cooldown.entries()) {
        if (now - lastTime > 60000) { // удаляем тех, кто писал больше минуты назад
            cooldown.delete(userId)
        }
    }

    // 3. Очистка зависших загрузок (если youtube-dl завис навсегда)
    for (const [userId, startTime] of activeDownloads.entries()) {
        if (now - startTime > 10800000) { // 3 часа (скачивание длится слишком долго - удаляем блокировку)
            activeDownloads.delete(userId)
        }
    }

}, 1800000)

bot.start(ctx => {

    ctx.reply(
        `🚀 DamirMedia Video Downloader

Поддерживаемые сервисы:

▶️ YouTube
🎵 TikTok
📸 Instagram
📺 VK / VK Clips
📡 Rutube
🟠 OK.ru
🐦 Twitter / X
📌 Pinterest

📎 Просто отправьте ссылку.

Создатель: DamirMedia`
    )

})

bot.on('text', async ctx => {

    const url = ctx.message.text.trim()

    if (!/^https?:\/\//i.test(url))
        return ctx.reply('❌ Отправьте корректную ссылку')

    const now = Date.now()
    const last = cooldown.get(ctx.from.id)

    if (last && now - last < 4000)
        return ctx.reply('⚠️ Подождите несколько секунд')

    cooldown.set(ctx.from.id, now)

    if (!ctx.session) ctx.session = {}
    ctx.session.url = url
    // сообщение ожидания
    const loadingMsg = await ctx.reply('🔎 Получаю информацию о видео...')

    let info = null

    try {

        info = await youtubedl(url, {
            dumpSingleJson: true,
            noWarnings: true,
            socketTimeout: 15000,
            forceIpv4: true
        })

    } catch (err) {

        console.log("Metadata error:", err.message)

    }

    const keyboard = Markup.inlineKeyboard([
        [
            Markup.button.callback('🎬 360p', 'video_360'),
            Markup.button.callback('🎬 720p', 'video_720')
        ],
        [
            Markup.button.callback('🎬 1080p', 'video_1080'),
            Markup.button.callback('🎬 Лучшее', 'video_best')
        ],
        [
            Markup.button.callback('🎵 Скачать MP3', 'mp3')
        ]
    ])

    if (info && info.thumbnail) {

        const title = info.title || 'Видео'

        const duration = info.duration
            ? Math.floor(info.duration / 60) + ':' + (info.duration % 60).toString().padStart(2, '0')
            : '—'

        const views = info.view_count
            ? info.view_count.toLocaleString()
            : '—'

        let thumb = info.thumbnail || ""

        if (thumb.includes("maxresdefault"))
            thumb = thumb.replace("maxresdefault", "hqdefault")

        if (!thumb.startsWith("http"))
            thumb = null

        const message =
            `🎬 ${title}

⏱ Длительность: ${duration}
👁 Просмотры: ${views}

Выберите формат:`

        if (thumb) {

            try {
                // удалить сообщение ожидания
                try { await ctx.deleteMessage(loadingMsg.message_id) } catch { }
                await ctx.replyWithPhoto(
                    { url: thumb },
                    {
                        caption: message,
                        ...keyboard
                    }
                )

            } catch (err) {

                console.log("Thumbnail error:", err.message)
                try { await ctx.deleteMessage(loadingMsg.message_id) } catch { }
                await ctx.reply(message, keyboard)

            }

        } else {
            try { await ctx.deleteMessage(loadingMsg.message_id) } catch { }
            await ctx.reply(message, keyboard)

        }

    } else {
        try { await ctx.deleteMessage(loadingMsg.message_id) } catch { }
        await ctx.reply(
            "📥 Видео найдено\n\nВыберите формат:",
            keyboard
        )

    }

})

bot.action(/video_(.+)|mp3/, async ctx => {

    const userId = ctx.from.id
    const url = ctx.session?.url
    const action = ctx.match[0]

    if (!url)
        return ctx.answerCbQuery('Ссылка устарела')

    if (activeDownloads.has(userId))
        return ctx.answerCbQuery('⏳ Загрузка уже выполняется')

    activeDownloads.set(userId, Date.now())

    await ctx.answerCbQuery()

    const loading = await ctx.reply('⬇️ Начинаю загрузку...')

    const id = crypto.randomBytes(6).toString('hex')

    const type = action === 'mp3' ? 'mp3' : 'video'
    const quality = type === 'video' ? action.replace('video_', '') : null
    const ext = type === 'mp3' ? 'mp3' : 'mp4'

    const output = path.join(tmpDir, `${id}.${ext}`)

    try {

        const args = {
            output,
            concurrentFragments: 8,
            retries: 3,
            maxFilesize: '1900M',
            noCheckCertificates: true,
            forceIpv4: true,
            geoBypass: true
        }

        if (type === 'mp3') {

            args.extractAudio = true
            args.audioFormat = 'mp3'

        } else {

            if (quality === '360')
                args.format = 'bestvideo[height<=360]+bestaudio/best[height<=360]'
            else if (quality === '720')
                args.format = 'bestvideo[height<=720]+bestaudio/best[height<=720]'
            else if (quality === '1080')
                args.format = 'bestvideo[height<=1080]+bestaudio/best[height<=1080]'
            else
                args.format = 'bestvideo+bestaudio/best'

            args.mergeOutputFormat = 'mp4'

        }

        const subprocess = youtubedl.exec(url, args)

        let progress = 0

        subprocess.stdout.on('data', async data => {

            const match = data.toString().match(/\[download]\s+([\d.]+)%/)

            if (match) {

                const p = parseFloat(match[1])

                if (p - progress > 10) {

                    progress = p

                    try {

                        await ctx.telegram.editMessageText(
                            ctx.chat.id,
                            loading.message_id,
                            undefined,
                            `⬇️ ${p.toFixed(1)}%`
                        )

                    } catch { }

                }

            }

        })

        await subprocess

        await ctx.telegram.editMessageText(
            ctx.chat.id,
            loading.message_id,
            undefined,
            '📤 Отправляю файл...'
        )

        if (type === 'mp3') {

            await ctx.replyWithAudio({
                source: output
            })

        } else {

            const videoExtra = {}

            const dims = getVideoDimensions(output)
            if (dims) {
                videoExtra.width = dims.width
                videoExtra.height = dims.height
            }

            await ctx.replyWithVideo({ source: output }, videoExtra)

        }

        fs.unlinkSync(output)

        await ctx.telegram.editMessageText(
            ctx.chat.id,
            loading.message_id,
            undefined,
            '✅ Готово'
        )

    } catch (err) {

        console.error(err)

        if (err && err.message && err.message.includes('File is larger than max-filesize')) {
            await ctx.reply('❌ Видео слишком большое для отправки в Telegram')
        } else {
            await ctx.reply('❌ Ошибка скачивания')
        }

        if (fs.existsSync(output))
            fs.unlinkSync(output)

    }

    activeDownloads.delete(userId)

})

bot.catch((err, ctx) => {

    console.error('BOT ERROR', err)

    ctx.reply('⚠️ Произошла ошибка')

})

bot.launch()

console.log('🚀 DamirMedia Bot started')

process.once('SIGINT', () => bot.stop())
process.once('SIGTERM', () => bot.stop())