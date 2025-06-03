# GasGuardian Userbot

This repository contains a Telegram userbot that helps discover recruitment channels and engage with them.

## Database initialization

When the bot starts it must have a table called `channelSearch` available. The `main` function now runs `ensureChannelSearchTable()` right after connecting to Telegram to create this table if needed. Ensure your `.env` points to a reachable database before starting the bot.
