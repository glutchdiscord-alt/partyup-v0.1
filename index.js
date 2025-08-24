const { Client, GatewayIntentBits, SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const cron = require('node-cron');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates
    ]
});

// Supported games from the images
const SUPPORTED_GAMES = {
    'valorant': { name: 'Valorant', modes: ['Competitive', 'Unrated', 'Spike Rush', 'Deathmatch'] },
    'fortnite': { name: 'Fortnite', modes: ['Battle Royale', 'Zero Build', 'Creative', 'Save the World'] },
    'brawlhalla': { name: 'Brawlhalla', modes: ['1v1', '2v2', 'Ranked', 'Experimental'] },
    'thefinals': { name: 'The Finals', modes: ['Quick Cash', 'Bank It', 'Tournament'] },
    'roblox': { name: 'Roblox', modes: ['Various', 'Roleplay', 'Simulator', 'Obby'] },
    'minecraft': { name: 'Minecraft', modes: ['Survival', 'Creative', 'PvP', 'Minigames'] },
    'marvelrivals': { name: 'Marvel Rivals', modes: ['Quick Match', 'Competitive', 'Custom'] },
    'rocketleague': { name: 'Rocket League', modes: ['3v3', '2v2', '1v1', 'Hoops'] },
    'apexlegends': { name: 'Apex Legends', modes: ['Trios', 'Duos', 'Ranked', 'Arenas'] },
    'callofduty': { name: 'Call of Duty', modes: ['Multiplayer', 'Warzone', 'Search & Destroy'] },
    'overwatch': { name: 'Overwatch', modes: ['Competitive', 'Quick Play', 'Arcade'] },
    'amongus': { name: 'Among Us', modes: ['Classic', 'Hide and Seek', 'Custom Rules', 'Private Lobby'] }
};

// Store active LFG sessions and categories
const activeSessions = new Map();
const gameCategories = new Map();
const guildSettings = new Map(); // Store guild-specific settings like LFG channel
const userCreatedSessions = new Map(); // Track which user created which session

// Session persistence helpers
function saveSessionData() {
    const sessionData = {
        activeSessions: Array.from(activeSessions.entries()),
        guildSettings: Array.from(guildSettings.entries()),
        userCreatedSessions: Array.from(userCreatedSessions.entries()),
        timestamp: Date.now()
    };
    
    try {
        // In production, you'd save this to a database
        // For now, we'll just log it for debugging
        console.log(`Saved ${sessionData.activeSessions.length} active sessions`);
        return sessionData;
    } catch (error) {
        console.error('Error saving session data:', error);
    }
}

function loadSessionData() {
    try {
        // In production, you'd load this from a database
        // For now, sessions will be lost on restart (but bot won't crash)
        console.log('Session persistence not implemented - sessions will be lost on restart');
    } catch (error) {
        console.error('Error loading session data:', error);
    }
}

// Auto-save session data every 5 minutes
setInterval(() => {
    if (activeSessions.size > 0) {
        saveSessionData();
    }
}, 5 * 60 * 1000);

client.once('ready', () => {
    console.log(`Bot is ready! Logged in as ${client.user.tag}`);
    loadSessionData(); // Load any persisted session data
    registerCommands();
    
    // Run cleanup every minute with error handling
    cron.schedule('* * * * *', async () => {
        try {
            await cleanupEmptyChannels();
        } catch (error) {
            console.error('Error in cleanup:', error);
        }
        
        try {
            await checkExpiredConfirmations();
        } catch (error) {
            console.error('Error checking confirmations:', error);
        }
        
        try {
            await checkExpiredLfgSessions();
        } catch (error) {
            console.error('Error checking sessions:', error);
        }
    });
});

async function registerCommands() {
    const commands = [
        new SlashCommandBuilder()
            .setName('lfg')
            .setDescription('Look for group - find teammates for your game')
            .addStringOption(option =>
                option.setName('game')
                    .setDescription('Choose a game')
                    .setRequired(true)
                    .addChoices(
                        ...Object.entries(SUPPORTED_GAMES).map(([key, game]) => ({
                            name: game.name,
                            value: key
                        }))
                    ))
            .addStringOption(option =>
                option.setName('gamemode')
                    .setDescription('Game mode')
                    .setRequired(true)
                    .setAutocomplete(true))
            .addIntegerOption(option =>
                option.setName('players')
                    .setDescription('Number of players needed (including you)')
                    .setRequired(true)
                    .setMinValue(2)
                    .setMaxValue(10))
            .addStringOption(option =>
                option.setName('info')
                    .setDescription('Additional information (optional)')
                    .setRequired(false)
                    .setMaxLength(200)),
        new SlashCommandBuilder()
            .setName('setchannel')
            .setDescription('Set the LFG channel (Staff only)')
            .addChannelOption(option =>
                option.setName('channel')
                    .setDescription('Channel where LFG commands are allowed')
                    .setRequired(true)
                    .addChannelTypes(ChannelType.GuildText))
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
        new SlashCommandBuilder()
            .setName('embed')
            .setDescription('Create custom embed messages (Staff only)')
            .addStringOption(option =>
                option.setName('title')
                    .setDescription('Embed title')
                    .setRequired(true))
            .addStringOption(option =>
                option.setName('description')
                    .setDescription('Embed description')
                    .setRequired(true))
            .addStringOption(option =>
                option.setName('color')
                    .setDescription('Embed color (hex code like #ff0000)')
                    .setRequired(false))
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
        new SlashCommandBuilder()
            .setName('mod')
            .setDescription('Moderation commands (Staff only)')
            .addStringOption(option =>
                option.setName('action')
                    .setDescription('Moderation action')
                    .setRequired(true)
                    .addChoices(
                        { name: 'Kick', value: 'kick' },
                        { name: 'Ban', value: 'ban' },
                        { name: 'Mute', value: 'mute' },
                        { name: 'Unmute', value: 'unmute' }
                    ))
            .addUserOption(option =>
                option.setName('user')
                    .setDescription('Target user')
                    .setRequired(true))
            .addStringOption(option =>
                option.setName('reason')
                    .setDescription('Reason for action')
                    .setRequired(false))
            .addStringOption(option =>
                option.setName('duration')
                    .setDescription('Duration for mute (e.g., 10m, 1h, 1d)')
                    .setRequired(false))
            .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
        new SlashCommandBuilder()
            .setName('help')
            .setDescription('Show all bot commands and features'),
        new SlashCommandBuilder()
            .setName('endlfg')
            .setDescription('End your active LFG session')
    ].map(command => command.toJSON());

    try {
        console.log('Started refreshing application (/) commands.');
        await client.application.commands.set(commands);
        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error('Error registering commands:', error);
    }
}

client.on('interactionCreate', async interaction => {
    if (interaction.isChatInputCommand()) {
        if (interaction.commandName === 'lfg') {
            await handleLfgCommand(interaction);
        } else if (interaction.commandName === 'setchannel') {
            await handleSetChannelCommand(interaction);
        } else if (interaction.commandName === 'embed') {
            await handleEmbedCommand(interaction);
        } else if (interaction.commandName === 'mod') {
            await handleModCommand(interaction);
        } else if (interaction.commandName === 'help') {
            await handleHelpCommand(interaction);
        } else if (interaction.commandName === 'endlfg') {
            await handleEndLfgCommand(interaction);
        }
        return;
    }
    
    if (interaction.isButton()) {
        if (interaction.customId.startsWith('join_lfg_')) {
            await handleJoinLfg(interaction);
        } else if (interaction.customId.startsWith('confirm_')) {
            await handleConfirmation(interaction);
        } else if (interaction.customId.startsWith('decline_')) {
            await handleDecline(interaction);
        } else if (interaction.customId.startsWith('leave_lfg_')) {
            await handleLeaveLfg(interaction);
        }
        return;
    }
    
    if (interaction.isAutocomplete()) {
        if (interaction.commandName === 'lfg') {
            const focusedOption = interaction.options.getFocused(true);
            
            if (focusedOption.name === 'gamemode') {
                const game = interaction.options.getString('game');
                if (game && SUPPORTED_GAMES[game]) {
                    const modes = SUPPORTED_GAMES[game].modes.filter(mode => 
                        mode.toLowerCase().includes(focusedOption.value.toLowerCase())
                    );
                    await interaction.respond(
                        modes.map(mode => ({ name: mode, value: mode }))
                    );
                } else {
                    await interaction.respond([]);
                }
            }
        }
    }
});

async function handleLfgCommand(interaction) {
    const game = interaction.options.getString('game');
    const gamemode = interaction.options.getString('gamemode');
    const playersNeeded = interaction.options.getInteger('players');
    const info = interaction.options.getString('info');
    const user = interaction.user;
    const guild = interaction.guild;

    // Check if user already has an active LFG session as creator
    const existingSession = userCreatedSessions.get(user.id);
    if (existingSession && activeSessions.has(existingSession)) {
        const session = activeSessions.get(existingSession);
        return interaction.reply({ 
            content: `❌ You already have an active LFG session (#${existingSession.slice(-6)}) for ${session.game}! Use \`/endlfg\` to end it first.`, 
            ephemeral: true 
        });
    }

    // Check if user is already in another LFG session
    const userInSession = Array.from(activeSessions.values()).find(s => 
        s.currentPlayers.includes(user.id)
    );
    
    if (userInSession) {
        return interaction.reply({ 
            content: `❌ You are already in an LFG session (#${userInSession.id.slice(-6)})! Leave it first before creating a new one.`, 
            ephemeral: true 
        });
    }

    // Check if LFG channel is set and if user is in the correct channel
    const guildSetting = guildSettings.get(guild.id);
    
    if (guildSetting && guildSetting.lfgChannel) {
        if (interaction.channel.id !== guildSetting.lfgChannel) {
            const lfgChannel = guild.channels.cache.get(guildSetting.lfgChannel);
            return interaction.reply({ 
                content: `❌ LFG commands can only be used in ${lfgChannel ? lfgChannel.toString() : 'the designated channel'}!`, 
                ephemeral: true 
            });
        }

    if (!SUPPORTED_GAMES[game]) {
        return interaction.reply({ content: 'Unsupported game selected.', ephemeral: true });
    }

    const gameData = SUPPORTED_GAMES[game];
    
    // Validate gamemode
    if (!gameData.modes.includes(gamemode)) {
        return interaction.reply({ 
            content: `Invalid mode for ${gameData.name}. Available modes: ${gameData.modes.join(', ')}`, 
            ephemeral: true 
        });
    }
    
    try {
        // Get or create game category
        const category = await getOrCreateGameCategory(guild, game, gameData.name);
        
        // Create private voice channel
        const voiceChannel = await guild.channels.create({
            name: `${gameData.name} - ${user.username}`,
            type: ChannelType.GuildVoice,
            parent: category.id,
            permissionOverwrites: [
                {
                    id: guild.roles.everyone.id,
                    deny: [PermissionFlagsBits.Connect, PermissionFlagsBits.ViewChannel]
                },
                {
                    id: user.id,
                    allow: [PermissionFlagsBits.Connect, PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Speak]
                }
            ]
        });

        // Create LFG session with improved ID generation
        const sessionId = `${user.id}-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`;
        const session = {
            id: sessionId,
            creator: user.id,
            guild: guild.id, // Store guild ID for reliable access
            channel: interaction.channel.id, // Store channel where LFG was posted
            game: gameData.name,
            gamemode: gamemode,
            playersNeeded: playersNeeded,
            info: info,
            currentPlayers: [user.id],
            confirmedPlayers: [],
            voiceChannel: voiceChannel.id,
            category: category.id,
            createdAt: Date.now(),
            confirmationStartTime: null, // When confirmation phase started
            status: 'waiting', // waiting, confirming, completed
            timeoutId: null // Store timeout ID for proper cleanup
        };

        activeSessions.set(sessionId, session);
        userCreatedSessions.set(user.id, sessionId); // Track creator

        // Create embed response
        const embed = new EmbedBuilder()
            .setColor(0x5865f2)
            .setTitle(`🎮 LFG: ${gameData.name}`)
            .setDescription(`Looking for ${playersNeeded - 1} more player(s)`)
            .addFields(
                { name: '🎮 Game', value: gameData.name, inline: true },
                { name: '🎯 Mode', value: gamemode, inline: true },
                { name: '👥 Players', value: `1/${playersNeeded}`, inline: true },
                { name: '👤 Current Players', value: `👑 ${user.displayName}`, inline: false },
                { name: '🔊 Voice Channel', value: `<#${voiceChannel.id}>\n*Private voice channel created for this team.\nAccess granted when you join!*`, inline: false }
            );
        
        // Add info field if provided
        if (info) {
            embed.addFields({ name: '📝 Additional Info', value: info, inline: false });
        }
        
        embed.setFooter({ text: `LFG #${sessionId.slice(-6)} • Created by ${user.displayName} | Today at ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}` })
            .setTimestamp();

        const joinButton = new ButtonBuilder()
            .setCustomId(`join_lfg_${sessionId}`)
            .setLabel('Join LFG')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('✅');

        const row = new ActionRowBuilder().addComponents(joinButton);

        const response = await interaction.reply({ embeds: [embed], components: [row] });
        
        // Store the message ID for reliable updates later
        session.messageId = response.id;

    } catch (error) {
        console.error('Error creating LFG session:', error);
        
        // Clean up any partially created resources
        if (userCreatedSessions.has(user.id)) {
            const partialSessionId = userCreatedSessions.get(user.id);
            activeSessions.delete(partialSessionId);
            userCreatedSessions.delete(user.id);
        }
        
        await interaction.reply({ content: 'Failed to create LFG session. Please try again.', ephemeral: true });
    }
}

async function getOrCreateGameCategory(guild, gameKey, gameName) {
    const categoryName = `🎮 ${gameName}`;
    
    // Check if category already exists
    let category = guild.channels.cache.find(c => 
        c.type === ChannelType.GuildCategory && c.name === categoryName
    );

    if (!category) {
        // Create new category
        category = await guild.channels.create({
            name: categoryName,
            type: ChannelType.GuildCategory,
            permissionOverwrites: [
                {
                    id: guild.roles.everyone.id,
                    allow: [PermissionFlagsBits.ViewChannel],
                    deny: [PermissionFlagsBits.Connect]
                }
            ]
        });
        
        gameCategories.set(gameKey, category.id);
        console.log(`Created category: ${categoryName}`);
    }

    return category;
}

// Store empty channel timestamps
const emptyChannelTimestamps = new Map();

// Cleanup empty channels every minute with improved reliability
async function cleanupEmptyChannels() {
    for (const guild of client.guilds.cache.values()) {
        try {
            // Verify bot has necessary permissions
            const botMember = guild.members.cache.get(client.user.id);
            if (!botMember || !botMember.permissions.has(PermissionFlagsBits.ManageChannels)) {
                console.log(`Skipping cleanup for guild ${guild.name} - missing permissions`);
                continue;
            }
            // Clean up empty LFG voice channels - but respect active LFG sessions for 20 minutes
            const voiceChannels = guild.channels.cache.filter(c => 
                c.type === ChannelType.GuildVoice && 
                c.members.size === 0 && 
                c.parent && 
                c.parent.name.startsWith('🎮')
            );

            for (const channel of voiceChannels.values()) {
                const now = Date.now();
                
                // Check if this channel belongs to an active LFG session
                const session = Array.from(activeSessions.values()).find(s => s.voiceChannel === channel.id);
                
                if (session) {
                    // Verify session is still valid
                    if (!session.guild || !session.creator || !session.currentPlayers) {
                        console.log(`Found corrupted session ${session.id}, removing...`);
                        activeSessions.delete(session.id);
                        userCreatedSessions.delete(session.creator);
                        // Allow channel to be cleaned up
                    } else if (session.status === 'waiting') {
                        // Active LFG session - don't delete the voice channel
                        // Voice channel will be deleted when:
                        // 1. Session times out after 20 minutes (handled by checkExpiredLfgSessions)
                        // 2. All players leave permanently (handled by leave LFG command)
                        console.log(`Protecting active LFG session voice channel: ${channel.name}`);
                        // Clear any empty timestamp since we're protecting this channel
                        emptyChannelTimestamps.delete(channel.id);
                    } else {
                        // Session in other states (started, ended, etc.) - allow normal cleanup
                        if (!emptyChannelTimestamps.has(channel.id)) {
                            // Mark channel as empty
                            emptyChannelTimestamps.set(channel.id, now);
                        } else {
                            // Check if channel has been empty for more than 5 minutes
                            const emptyTime = now - emptyChannelTimestamps.get(channel.id);
                            if (emptyTime > 300000) { // 5 minutes for non-waiting sessions
                                await channel.delete();
                                emptyChannelTimestamps.delete(channel.id);
                                console.log(`Deleted empty voice channel: ${channel.name} (session not waiting, 5min cleanup)`);
                            }
                        }
                    }
                } else {
                    // No active session, use regular 1-minute cleanup
                    if (!emptyChannelTimestamps.has(channel.id)) {
                        // Mark channel as empty
                        emptyChannelTimestamps.set(channel.id, now);
                    } else {
                        // Check if channel has been empty for more than 1 minute
                        const emptyTime = now - emptyChannelTimestamps.get(channel.id);
                        if (emptyTime > 60000) { // 1 minute
                            await channel.delete();
                            emptyChannelTimestamps.delete(channel.id);
                            console.log(`Deleted empty voice channel: ${channel.name} (no active session)`);
                        }
                    }
                }
            }

            // Clean up empty game categories
            const gameCategories = guild.channels.cache.filter(c => 
                c.type === ChannelType.GuildCategory && 
                c.name.startsWith('🎮') &&
                c.children.cache.size === 0
            );
            
            for (const category of gameCategories.values()) {
                await category.delete();
                console.log(`Deleted empty category: ${category.name}`);
            }

        } catch (error) {
            console.error('Error during cleanup:', error);
        }
    }
}

// Handle voice state changes
client.on('voiceStateUpdate', async (oldState, newState) => {
    // Handle someone leaving a channel
    if (oldState.channel && oldState.channel.members.size === 0) {
        // Channel became empty - start tracking for cleanup
        if (oldState.channel.parent && oldState.channel.parent.name.startsWith('🎮')) {
            emptyChannelTimestamps.set(oldState.channel.id, Date.now());
        }
    }
    
    // Handle someone joining a channel
    if (newState.channel && emptyChannelTimestamps.has(newState.channel.id)) {
        // Channel is no longer empty - stop tracking for cleanup
        emptyChannelTimestamps.delete(newState.channel.id);
    }
    
    // Handle joining LFG voice channels - only allow if in session
    if (newState.channel) {
        const session = Array.from(activeSessions.values()).find(s => s.voiceChannel === newState.channel.id);
        
        if (session) {
            // Only allow users who are part of the LFG session
            if (session.currentPlayers.includes(newState.member.id) || session.confirmedPlayers.includes(newState.member.id)) {
                console.log(`${newState.member.displayName} joined LFG voice channel: ${session.game}`);
            } else {
                // Kick users who aren't part of the session
                try {
                    await newState.member.voice.disconnect('Not part of this LFG session');
                    console.log(`Kicked ${newState.member.displayName} from LFG voice channel - not in session`);
                } catch (error) {
                    console.error('Error kicking unauthorized user:', error);
                }
            }
        }
    }
    
    // Handle members leaving voice - track for potential session cleanup
    if (oldState.channel && !newState.channel) {
        const session = Array.from(activeSessions.values()).find(s => s.voiceChannel === oldState.channel.id);
        if (session && session.currentPlayers.includes(oldState.member.id)) {
            console.log(`Member ${oldState.member.displayName} left LFG voice channel for session ${session.id.slice(-6)}`);
        }
    }
});

// New command handlers
async function handleSetChannelCommand(interaction) {
    
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
        return interaction.reply({ content: '❌ You need Manage Channels permission to use this command!', ephemeral: true });
    }

    const channel = interaction.options.getChannel('channel');
    const guildId = interaction.guild.id;
    
    
    // Initialize guild settings if not exists
    if (!guildSettings.has(guildId)) {
        guildSettings.set(guildId, {});
    }
    
    // Set the LFG channel
    const settings = guildSettings.get(guildId);
    settings.lfgChannel = channel.id;
    guildSettings.set(guildId, settings); // Make sure to set it back
    
    
    const embed = new EmbedBuilder()
        .setColor(0x00ff00)
        .setTitle('✅ LFG Channel Set')
        .setDescription(`LFG commands can now only be used in ${channel.toString()}`)
        .setTimestamp();
    
    await interaction.reply({ embeds: [embed] });
}

async function handleEmbedCommand(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
        return interaction.reply({ content: '❌ You need Manage Messages permission to use this command!', ephemeral: true });
    }

    const title = interaction.options.getString('title');
    const description = interaction.options.getString('description');
    const colorInput = interaction.options.getString('color') || '#5865f2';
    
    let color = 0x5865f2;
    if (colorInput.startsWith('#')) {
        color = parseInt(colorInput.slice(1), 16);
    }
    
    const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(description)
        .setColor(color)
        .setTimestamp();
    
    await interaction.reply({ embeds: [embed] });
}

async function handleModCommand(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
        return interaction.reply({ content: '❌ You need Moderate Members permission to use this command!', ephemeral: true });
    }

    const action = interaction.options.getString('action');
    const targetUser = interaction.options.getMember('user');
    const reason = interaction.options.getString('reason') || 'No reason provided';
    const duration = interaction.options.getString('duration');
    
    if (!targetUser) {
        return interaction.reply({ content: '❌ User not found in this server!', ephemeral: true });
    }
    
    if (targetUser.roles.highest.position >= interaction.member.roles.highest.position) {
        return interaction.reply({ content: '❌ You cannot moderate this user (equal or higher role)!', ephemeral: true });
    }
    
    try {
        switch (action) {
            case 'kick':
                await targetUser.kick(reason);
                await removeMemberFromAllSessions(targetUser.id);
                await interaction.reply(`✅ Kicked ${targetUser.user.tag} - ${reason}`);
                break;
                
            case 'ban':
                await targetUser.ban({ reason, deleteMessageDays: 1 });
                await removeMemberFromAllSessions(targetUser.id);
                await interaction.reply(`✅ Banned ${targetUser.user.tag} - ${reason}`);
                break;
                
            case 'mute':
                const timeoutDuration = parseDuration(duration || '1h');
                await targetUser.timeout(timeoutDuration, reason);
                await interaction.reply(`✅ Muted ${targetUser.user.tag} for ${duration || '1h'} - ${reason}`);
                break;
                
            case 'unmute':
                await targetUser.timeout(null, reason);
                await interaction.reply(`✅ Unmuted ${targetUser.user.tag} - ${reason}`);
                break;
        }
    } catch (error) {
        console.error('Moderation error:', error);
        await interaction.reply({ content: `❌ Failed to ${action} user: ${error.message}`, ephemeral: true });
    }
}

async function handleJoinLfg(interaction) {
    try {
        const sessionId = interaction.customId.replace('join_lfg_', '');
        const session = activeSessions.get(sessionId);
        
        console.log(`User ${interaction.user.displayName} (${interaction.user.id}) attempting to join session ${sessionId}`);
        
        if (!session) {
            console.log(`Session ${sessionId} not found`);
            
            // Try to find and disable this outdated button
            try {
                const embed = new EmbedBuilder()
                    .setColor(0x95a5a6)
                    .setTitle('❌ LFG Session Expired')
                    .setDescription('This LFG session is no longer active.')
                    .setTimestamp();
                
                await interaction.update({ embeds: [embed], components: [] });
                console.log(`Disabled outdated LFG button for session ${sessionId}`);
            } catch (updateError) {
                console.error('Error disabling outdated button:', updateError);
                return interaction.reply({ content: '❌ This LFG session is no longer active!', flags: 64 });
            }
            return;
        }
        
        if (session.currentPlayers.includes(interaction.user.id)) {
            // User is already in this session, show enhanced status
            const statusEmbed = new EmbedBuilder()
                .setColor(0xffa500)
                .setTitle('ℹ️ **Already in Team!**')
                .setDescription(`**You're already part of this ${session.game} session**\n\n👥 **Team:** ${session.currentPlayers.length}/${session.playersNeeded}\n🔊 **Voice:** <#${session.voiceChannel}>\n⏰ **Status:** ${session.status === 'confirming' ? 'Waiting for confirmations' : 'Looking for more players'}\n\n*Click **Leave Team** if you want to exit this session.*`)
                .setTimestamp();
            
            const leaveButton = new ButtonBuilder()
                .setCustomId(`leave_lfg_${sessionId}`)
                .setLabel('Leave Team')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('🚪');
            
            const row = new ActionRowBuilder().addComponents(leaveButton);
            
            console.log(`User ${interaction.user.id} (${interaction.user.displayName}) tried to join session they're already in`);
            
            return interaction.reply({ 
                embeds: [statusEmbed],
                components: [row],
                flags: 64 
            });
        }
        
        if (session.currentPlayers.length >= session.playersNeeded) {
            const fullEmbed = new EmbedBuilder()
                .setColor(0xff9900)
                .setTitle('🚫 **Team is Full!**')
                .setDescription(`**This ${session.game} session is already complete**\n\n👥 **Team:** ${session.currentPlayers.length}/${session.playersNeeded}\n🎮 **Status:** ${session.status === 'confirming' ? 'Players confirming' : 'Team filled'}\n\n🔍 Try creating your own LFG with \`/lfg\`!`)
                .setTimestamp();
                
            return interaction.reply({ embeds: [fullEmbed], flags: 64 });
        }
        
        // Check if user is already in another LFG session (improved check)
        const userInOtherSession = Array.from(activeSessions.values()).find(s => 
            s.id !== sessionId && s.currentPlayers.includes(interaction.user.id)
        );
        
        if (userInOtherSession) {
            const conflictEmbed = new EmbedBuilder()
                .setColor(0xff6b6b)
                .setTitle('⚠️ **Already in Another Team!**')
                .setDescription(`**You can only be in one LFG session at a time**\n\n🎮 **Current Session:** ${userInOtherSession.game}\n🆔 **Session ID:** #${userInOtherSession.id.slice(-6)}\n👥 **Team:** ${userInOtherSession.currentPlayers.length}/${userInOtherSession.playersNeeded}\n\n🚪 Leave your current session first to join this one!`)
                .setTimestamp();
                
            return interaction.reply({ 
                embeds: [conflictEmbed],
                flags: 64 
            });
        }
        
        // Add user to session
        session.currentPlayers.push(interaction.user.id);
    
    // Grant voice channel access to the new player
    try {
        const voiceChannel = interaction.guild.channels.cache.get(session.voiceChannel);
        if (voiceChannel) {
            await voiceChannel.permissionOverwrites.create(interaction.user.id, {
                Connect: true,
                ViewChannel: true,
                Speak: true
            });
            console.log(`Granted voice access to ${interaction.user.displayName}`);
        }
    } catch (error) {
        console.error('Error granting voice channel access:', error);
    }
    
    // Create enhanced embed with better visuals
    const isFull = session.currentPlayers.length === session.playersNeeded;
    const spotsLeft = session.playersNeeded - session.currentPlayers.length;
    
    // Create visual progress bar
    const progressBar = createProgressBar(session.currentPlayers.length, session.playersNeeded);
    
    const embed = new EmbedBuilder()
        .setColor(isFull ? 0x00ff00 : 0x5865f2)
        .setTitle(`🎮 ${session.game} • ${session.gamemode}`)
        .setDescription(isFull ? 
            '🎯 **Team is full!** Waiting for confirmations...' : 
            `🔍 **Looking for ${spotsLeft} more ${spotsLeft === 1 ? 'player' : 'players'}**`)
        .addFields(
            { 
                name: '👥 Team Progress', 
                value: `${progressBar}\n**${session.currentPlayers.length}/${session.playersNeeded} players**`, 
                inline: false 
            },
            { 
                name: '🎮 Game Details', 
                value: `**Game:** ${session.game}\n**Mode:** ${session.gamemode}\n**Skill Level:** Open to All`, 
                inline: true 
            },
            { 
                name: '⏱️ Session Info', 
                value: `**Status:** ${isFull ? 'Full - Confirming' : 'Open'}\n**Created:** ${getTimeAgo(session.createdAt)}\n**Expires:** ${getExpiryTime(session.createdAt)}`, 
                inline: true 
            },
            { 
                name: '👤 Current Team', 
                value: session.currentPlayers.map((id, index) => {
                    const user = interaction.guild.members.cache.get(id);
                    const userName = user ? user.displayName : 'Unknown';
                    const role = index === 0 ? '👑 **Leader**' : '⚔️ **Member**';
                    const status = '🟢'; // Always online since they just joined
                    return `${status} ${role} ${userName}`;
                }).join('\n'), 
                inline: false 
            },
            { 
                name: '🔊 Voice Channel', 
                value: `<#${session.voiceChannel}>\n🔒 **Private channel** - access granted when you join!\n🎤 Voice chat ready for your team`, 
                inline: false 
            }
        );
    
    // Add info field if provided
    if (session.info) {
        embed.addFields({ name: '📝 Additional Info', value: session.info, inline: false });
    }
    
    // Add info field if provided
    if (session.info) {
        embed.addFields({ name: '📝 Additional Info', value: session.info, inline: false });
    }
    
    embed.setFooter({ 
        text: `Session #${sessionId.slice(-6)} • Created by ${interaction.guild.members.cache.get(session.creator)?.displayName || 'Unknown'}`,
        iconURL: interaction.guild.members.cache.get(session.creator)?.displayAvatarURL() || null
    })
    .setTimestamp();
    
    if (session.currentPlayers.length === session.playersNeeded) {
        // Team is full, start enhanced confirmation process
        session.status = 'confirming';
        session.confirmationStartTime = Date.now();
        
        const confirmButton = new ButtonBuilder()
            .setCustomId(`confirm_${sessionId}`)
            .setLabel('Ready to Play!')
            .setStyle(ButtonStyle.Success)
            .setEmoji('🎮');
            
        const declineButton = new ButtonBuilder()
            .setCustomId(`decline_${sessionId}`)
            .setLabel('Not Available')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('❌');
            
        const row = new ActionRowBuilder().addComponents(confirmButton, declineButton);
        
        await interaction.update({ embeds: [embed], components: [row] });
        
        // Enhanced confirmation message with better visuals
        const playerPings = session.currentPlayers.map(id => `<@${id}>`).join(' ');
        const confirmEmbed = new EmbedBuilder()
            .setColor(0xffd700)
            .setTitle('🎯 **TEAM ASSEMBLED!**')
            .setDescription(`**All players found for ${session.game}!**\n\n⏰ **You have 2 minutes to confirm**\nClick **Ready to Play!** if you're available right now.\n\n🔊 Voice channel: <#${session.voiceChannel}>`)
            .setTimestamp();
            
        await interaction.followUp({ 
            content: `${playerPings}`,
            embeds: [confirmEmbed],
            allowedMentions: { users: session.currentPlayers }
        });
        
        session.timeoutId = setTimeout(() => handleConfirmationTimeout(sessionId), 120000);
        console.log(`Started confirmation timeout for session ${sessionId} at ${new Date().toISOString()}`);
    } else {
        const joinButton = new ButtonBuilder()
            .setCustomId(`join_lfg_${sessionId}`)
            .setLabel(`Join Team (${spotsLeft} spots left)`)
            .setStyle(ButtonStyle.Primary)
            .setEmoji('⚡');
        
        const row = new ActionRowBuilder().addComponents(joinButton);
        
        await interaction.update({ content: '', embeds: [embed], components: [row] });
    }
    
    // Enhanced join confirmation with better UX
    const successEmbed = new EmbedBuilder()
        .setColor(0x00ff00)
        .setTitle('🎉 Welcome to the Team!')
        .setDescription(`**Successfully joined ${session.game}!**\n\n🔊 **Voice Channel:** <#${session.voiceChannel}>\n🎮 **Mode:** ${session.gamemode}\n👥 **Team Size:** ${session.currentPlayers.length}/${session.playersNeeded}\n\n${session.currentPlayers.length === session.playersNeeded ? '⏰ **Get ready!** Confirmation starting soon...' : `🔍 **Waiting for ${spotsLeft} more ${spotsLeft === 1 ? 'player' : 'players'}**`}`)
        .setTimestamp();
    
    const leaveButton = new ButtonBuilder()
        .setCustomId(`leave_lfg_${sessionId}`)
        .setLabel('Leave Team')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('🚪');
    
    const leaveRow = new ActionRowBuilder().addComponents(leaveButton);
    
    await interaction.followUp({ 
        embeds: [successEmbed], 
        components: [leaveRow],
        flags: 64 
    });
    } catch (error) {
        console.error('Error in handleJoinLfg:', error);
        try {
            await interaction.reply({ 
                content: '❌ Something went wrong. Please try again.', 
                flags: 64 
            });
        } catch (replyError) {
            console.error('Error replying to interaction:', replyError);
        }
    }
}

async function handleConfirmation(interaction) {
    const sessionId = interaction.customId.replace('confirm_', '');
    const session = activeSessions.get(sessionId);
    
    if (!session) {
        const expiredEmbed = new EmbedBuilder()
            .setColor(0x95a5a6)
            .setTitle('⏰ **Session Expired**')
            .setDescription('This LFG session is no longer active or has been completed.\n\n🆕 Create a new session with `/lfg`')
            .setTimestamp();
        return interaction.reply({ embeds: [expiredEmbed], flags: 64 });
    }
    
    if (!session.currentPlayers.includes(interaction.user.id)) {
        const notInSessionEmbed = new EmbedBuilder()
            .setColor(0xff6b6b)
            .setTitle('❌ **Not in Team**')
            .setDescription('You are not part of this LFG session!\n\n🔍 Look for open sessions or create your own with `/lfg`')
            .setTimestamp();
        return interaction.reply({ embeds: [notInSessionEmbed], flags: 64 });
    }
    
    if (session.status !== 'confirming') {
        const notConfirmingEmbed = new EmbedBuilder()
            .setColor(0xffa500)
            .setTitle('⚠️ **Not in Confirmation Phase**')
            .setDescription('This session is not currently asking for confirmations.\n\n⏰ Wait for the team to fill up!')
            .setTimestamp();
        return interaction.reply({ embeds: [notConfirmingEmbed], flags: 64 });
    }
    
    if (session.confirmedPlayers.includes(interaction.user.id)) {
        const alreadyConfirmedEmbed = new EmbedBuilder()
            .setColor(0x00ff00)
            .setTitle('✅ **Already Confirmed!**')
            .setDescription(`You've already confirmed for this ${session.game} session!\n\n⏰ Waiting for other players to confirm...`)
            .setTimestamp();
        return interaction.reply({ embeds: [alreadyConfirmedEmbed], flags: 64 });
    }
    
    session.confirmedPlayers.push(interaction.user.id);
    
    if (session.confirmedPlayers.length === session.currentPlayers.length) {
        // All players confirmed - clear timeout and finalize
        if (session.timeoutId) {
            clearTimeout(session.timeoutId);
            session.timeoutId = null;
        }
        session.confirmationStartTime = null; // Clear confirmation time
        console.log(`All players confirmed for session ${sessionId}, finalizing`);
        await finalizeSession(session, interaction);
    } else {
        await interaction.reply({ content: '✅ Confirmed! Waiting for other players...', flags: 64 });
    }
}

async function handleDecline(interaction) {
    const sessionId = interaction.customId.replace('decline_', '');
    const session = activeSessions.get(sessionId);
    
    if (!session || !session.currentPlayers.includes(interaction.user.id)) {
        return interaction.reply({ content: '❌ You are not part of this LFG!', ephemeral: true });
    }
    
    // Check if the session creator is declining - if so, cancel entire session
    if (interaction.user.id === session.creator) {
        console.log(`Session creator ${interaction.user.displayName} declined session ${sessionId}, cancelling entire session`);
        
        // Clear timeout
        if (session.timeoutId) {
            clearTimeout(session.timeoutId);
            session.timeoutId = null;
        }
        
        // Delete voice channel
        try {
            const voiceChannel = interaction.guild.channels.cache.get(session.voiceChannel);
            if (voiceChannel) {
                await voiceChannel.delete();
            }
        } catch (error) {
            console.error('Error deleting voice channel:', error);
        }
        
        // Remove session
        activeSessions.delete(sessionId);
        userCreatedSessions.delete(session.creator); // Clean up creator tracking
        
        // Update embed to show session cancelled
        const cancelledEmbed = new EmbedBuilder()
            .setColor(0xff6b6b)
            .setTitle('❌ LFG Session Cancelled')
            .setDescription(`The session creator cancelled this LFG.`)
            .setTimestamp();
        
        await interaction.update({ embeds: [cancelledEmbed], components: [] });
        await interaction.followUp({ content: '❌ You cancelled your LFG session.', ephemeral: true });
        return;
    }
    
    // Regular player declining - remove them and continue
    session.currentPlayers = session.currentPlayers.filter(id => id !== interaction.user.id);
    session.confirmedPlayers = session.confirmedPlayers.filter(id => id !== interaction.user.id);
    
    // Clear timeout if it exists (someone declined, so we're reopening)
    if (session.timeoutId) {
        clearTimeout(session.timeoutId);
        session.timeoutId = null;
    }
    session.confirmationStartTime = null; // Clear confirmation time
    console.log(`Player ${interaction.user.displayName} declined session ${sessionId}, reopening`);
    
    // Remove voice channel access
    try {
        const voiceChannel = interaction.guild.channels.cache.get(session.voiceChannel);
        if (voiceChannel) {
            await voiceChannel.permissionOverwrites.delete(interaction.user.id);
            // Disconnect if user is in the voice channel
            if (interaction.member.voice.channel?.id === session.voiceChannel) {
                await interaction.member.voice.disconnect('Declined LFG session');
            }
        }
    } catch (error) {
        console.error('Error removing voice channel access:', error);
    }
    
    await interaction.reply({ content: '❌ You declined the LFG session.', ephemeral: true });
    
    // Reopen LFG for remaining spots
    await reopenLfg(session);
}

async function handleConfirmationTimeout(sessionId) {
    const session = activeSessions.get(sessionId);
    
    if (!session || session.status !== 'confirming') {
        console.log(`Timeout called for session ${sessionId} but session not found or not confirming`);
        return;
    }
    
    console.log(`Processing confirmation timeout for session ${sessionId}`);
    
    // Clear the timeout reference
    session.timeoutId = null;
    
    // Get players who didn't confirm
    const unconfirmedPlayers = session.currentPlayers.filter(id => !session.confirmedPlayers.includes(id));
    console.log(`Unconfirmed players: ${unconfirmedPlayers.length}, Confirmed players: ${session.confirmedPlayers.length}`);
    
    // Remove voice channel access from unconfirmed players
    try {
        const guild = client.guilds.cache.get(session.guild);
        const voiceChannel = guild?.channels.cache.get(session.voiceChannel);
        
        if (voiceChannel) {
            for (const playerId of unconfirmedPlayers) {
                await voiceChannel.permissionOverwrites.delete(playerId);
                
                // Disconnect if user is in the voice channel
                const member = guild.members.cache.get(playerId);
                if (member && member.voice.channel?.id === session.voiceChannel) {
                    await member.voice.disconnect('Failed to confirm in time');
                }
            }
        }
    } catch (error) {
        console.error('Error removing voice access from unconfirmed players:', error);
    }
    
    // Always keep the creator + all confirmed players
    const confirmedPlayersSet = new Set(session.confirmedPlayers);
    const keepPlayers = [session.creator, ...session.confirmedPlayers];
    
    // Remove duplicates (in case creator also confirmed)
    session.currentPlayers = [...new Set(keepPlayers)];
    
    console.log(`Keeping creator + ${session.confirmedPlayers.length} confirmed players = ${session.currentPlayers.length} total players`);
    
    session.confirmedPlayers = [];
    session.status = 'waiting';
    session.confirmationStartTime = null; // Reset confirmation time
    
    await reopenLfg(session, null);
}

// Backup function to check for expired confirmations (runs every minute)
async function checkExpiredConfirmations() {
    const now = Date.now();
    const twoMinutes = 2 * 60 * 1000; // 2 minutes in milliseconds
    
    for (const [sessionId, session] of activeSessions) {
        if (session.status === 'confirming' && session.confirmationStartTime) {
            const elapsed = now - session.confirmationStartTime;
            
            if (elapsed >= twoMinutes) {
                console.log(`Found expired confirmation for session ${sessionId}, processing timeout`);
                await handleConfirmationTimeout(sessionId);
            }
        }
    }
}

async function checkExpiredLfgSessions() {
    const now = Date.now();
    const twentyMinutes = 20 * 60 * 1000; // 20 minutes in milliseconds
    
    for (const [sessionId, session] of activeSessions) {
        // Only check sessions that are in 'waiting' status with only the creator (no one joined)
        if (session.status === 'waiting' && session.currentPlayers.length === 1) {
            const elapsed = now - session.createdAt;
            
            if (elapsed >= twentyMinutes) {
                console.log(`Found expired LFG session ${sessionId} with no joiners, processing timeout`);
                await handleLfgTimeout(sessionId);
            }
        }
    }
}

async function handleLfgTimeout(sessionId) {
    const session = activeSessions.get(sessionId);
    if (!session) return;
    
    try {
        // Get guild and channel for updating the embed
        const guild = client.guilds.cache.get(session.guild);
        const channel = guild?.channels.cache.get(session.channel);
        
        if (!guild || !channel) {
            console.error(`Guild or channel not found for expired session ${sessionId}`);
            activeSessions.delete(sessionId);
            return;
        }
        
        // Get the creator's display name
        const creator = guild.members.cache.get(session.creator);
        const creatorName = creator ? creator.displayName : 'Unknown User';
        
        // Create the expired embed
        const embed = new EmbedBuilder()
            .setColor(0x2b2d31) // Dark gray color to match the image
            .setTitle('LFG queue ended')
            .setDescription('no player was found in time ( 20 minutes)')
            .addFields(
                { name: '👤 Session Creator', value: `${creatorName}, your LFG session expired because no players joined within 20 minutes.\n\nYou can create a new LFG session anytime using \`/lfg\``, inline: false }
            )
            .setFooter({ text: `Today at ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}` })
            .setTimestamp();
        
        // Update the original message using stored message ID, or send new message if it fails
        let messageUpdated = false;
        
        try {
            if (session.messageId) {
                const originalMessage = await channel.messages.fetch(session.messageId);
                await originalMessage.edit({ embeds: [embed], components: [] });
                console.log(`Updated original LFG message for expired session ${sessionId}`);
                messageUpdated = true;
            }
        } catch (error) {
            console.error('Error updating original message with stored ID:', error);
        }
        
        // If direct message update failed, try multiple fallback searches
        if (!messageUpdated) {
            try {
                // Fallback 1: Search by session ID in footer
                const messages = await channel.messages.fetch({ limit: 50 });
                let originalMessage = messages.find(msg => 
                    msg.embeds.length > 0 && 
                    msg.embeds[0].footer?.text?.includes(sessionId.slice(-6)) &&
                    msg.components.length > 0 &&
                    msg.components[0].components.some(comp => comp.customId?.includes(`join_lfg_${sessionId}`))
                );
                
                if (originalMessage) {
                    await originalMessage.edit({ embeds: [embed], components: [] });
                    console.log(`Updated LFG message using session ID search for expired session ${sessionId}`);
                    messageUpdated = true;
                } else {
                    // Fallback 2: Extended search in more messages
                    const moreMessages = await channel.messages.fetch({ limit: 100 });
                    originalMessage = moreMessages.find(msg => 
                        msg.embeds.length > 0 && 
                        msg.embeds[0].title?.includes(session.game) &&
                        msg.embeds[0].footer?.text?.includes(sessionId.slice(-6))
                    );
                    
                    if (originalMessage) {
                        await originalMessage.edit({ embeds: [embed], components: [] });
                        console.log(`Updated LFG message using extended search for expired session ${sessionId}`);
                        messageUpdated = true;
                    }
                }
            } catch (error) {
                console.error('Error in fallback message searches:', error);
            }
        }
        
        // If we still couldn't update the original message, don't create a new one - just log it
        if (!messageUpdated) {
            console.log(`Could not find original message for expired session ${sessionId} - message may have been deleted`);
        }
        
        // Clean up the voice channel
        try {
            const voiceChannel = guild.channels.cache.get(session.voiceChannel);
            if (voiceChannel) {
                await voiceChannel.delete();
                console.log(`Deleted voice channel for expired session ${sessionId}`);
            }
        } catch (error) {
            console.error('Error deleting voice channel for expired session:', error);
        }
        
        // Remove the session
        activeSessions.delete(sessionId);
        userCreatedSessions.delete(session.creator); // Clean up creator tracking
        console.log(`Cleaned up expired LFG session ${sessionId}`);
        
    } catch (error) {
        console.error('Error handling LFG timeout:', error);
        // Still remove the session to prevent memory leaks
        activeSessions.delete(sessionId);
    }
}

async function reopenLfg(session) {
    if (session.currentPlayers.length === 0) {
        // No one left, delete session
        try {
            const guild = client.guilds.cache.get(session.guild);
            const channel = guild?.channels.cache.get(session.voiceChannel);
            if (channel) await channel.delete();
        } catch (error) {
            console.error('Error deleting voice channel:', error);
        }
        activeSessions.delete(session.id);
        userCreatedSessions.delete(session.creator); // Clean up creator tracking
        return;
    }
    
    session.status = 'waiting';
    
    // Get guild reliably using stored guild ID
    const guild = client.guilds.cache.get(session.guild);
    if (!guild) {
        console.error(`Guild not found for session ${session.id}`);
        return;
    }
    
    const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`🎮 LFG: ${session.game}`)
        .setDescription(`Looking for ${session.playersNeeded - session.currentPlayers.length} more player(s)`)
        .addFields(
            { name: '🎮 Game', value: session.game, inline: true },
            { name: '🎯 Mode', value: session.gamemode, inline: true },
            { name: '👥 Players', value: `${session.currentPlayers.length}/${session.playersNeeded}`, inline: true },
            { name: '👤 Current Players', value: session.currentPlayers.map((id, index) => {
                const user = guild.members.cache.get(id);
                return `${index === 0 ? '👑' : '⚔️'} ${user ? user.displayName : 'Unknown'}`;
            }).join('\n'), inline: false },
            { name: '🔊 Voice Channel', value: `<#${session.voiceChannel}>\n*Private voice channel created for this team.\nAccess granted when you join!*`, inline: false }
        )
        .setFooter({ text: `LFG #${session.id.slice(-6)} • Looking for ${session.playersNeeded - session.currentPlayers.length} more player(s)` })
        .setTimestamp();
    
    const joinButton = new ButtonBuilder()
        .setCustomId(`join_lfg_${session.id}`)
        .setLabel('Join LFG')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('✅');
    
    const row = new ActionRowBuilder().addComponents(joinButton);
    
    // Use the stored channel where the original LFG was posted
    const channel = guild.channels.cache.get(session.channel);
    
    if (channel) {
        let messageUpdated = false;
        
        // Try to update the original message first
        try {
            if (session.messageId) {
                const originalMessage = await channel.messages.fetch(session.messageId);
                await originalMessage.edit({ embeds: [embed], components: [row] });
                console.log(`Updated original LFG message for reopened session ${session.id}`);
                messageUpdated = true;
            } else {
                // Fallback: try to find the message if no ID stored
                const messages = await channel.messages.fetch({ limit: 50 });
                const originalMessage = messages.find(msg => 
                    msg.embeds.length > 0 && 
                    msg.embeds[0].footer?.text?.includes(session.id.slice(-6))
                );
                
                if (originalMessage) {
                    await originalMessage.edit({ embeds: [embed], components: [row] });
                    console.log(`Updated LFG message using fallback search for reopened session ${session.id}`);
                    messageUpdated = true;
                }
            }
        } catch (error) {
            console.error('Error updating original message:', error);
            
            // If message fetch failed, try broader search to find and update the button
            try {
                const messages = await channel.messages.fetch({ limit: 100 });
                const originalMessage = messages.find(msg => 
                    msg.embeds.length > 0 && 
                    msg.embeds[0].footer?.text?.includes(session.id.slice(-6)) &&
                    (msg.components.length === 0 || 
                     msg.components[0].components.some(comp => comp.customId?.includes(`join_lfg_${session.id}`)))
                );
                
                if (originalMessage) {
                    await originalMessage.edit({ embeds: [embed], components: [row] });
                    console.log(`Found and updated LFG message using extended search for reopened session ${session.id}`);
                    messageUpdated = true;
                }
            } catch (secondError) {
                console.error('Extended search also failed:', secondError);
            }
        }
        
        // If we couldn't update the original message, send a new one as last resort
        if (!messageUpdated) {
            try {
                const response = await channel.send({ 
                    content: `${session.currentPlayers.map(id => `<@${id}>`).join(' ')} **A player left your LFG session!**\n\nYour team is looking for **${session.playersNeeded - session.currentPlayers.length} more player(s)** to complete the squad.`,
                    embeds: [embed], 
                    components: [row],
                    allowedMentions: { users: session.currentPlayers }
                });
                // Update the session with new message ID
                session.messageId = response.id;
                console.log(`Sent new reopened message for session ${session.id} since original couldn't be updated`);
            } catch (sendError) {
                console.error('Error sending new reopened message:', sendError);
            }
        }
    } else {
        console.error(`No suitable channel found to reopen LFG ${session.id}`);
    }
}

async function finalizeSession(session, interaction) {
    session.status = 'active';
    const gameEmoji = getGameEmoji(session.game);
    
    // Create spectacular final embed
    const embed = new EmbedBuilder()
        .setColor(0x00ff00)
        .setTitle(`${gameEmoji} **GAME ON!** ${gameEmoji}`)
        .setDescription(`**🎆 ${session.game} match confirmed! 🎆**\n\n✨ All players are ready - time to dominate!`)
        .addFields(
            { 
                name: '🎮 Game Session Details', 
                value: `**Game:** ${session.game}\n**Mode:** ${session.gamemode}\n**Players:** ${session.confirmedPlayers.length}\n**Status:** 🟢 Active`, 
                inline: true 
            },
            { 
                name: '🔊 Voice Communication', 
                value: `**Channel:** <#${session.voiceChannel}>\n**Access:** ✅ Granted to all\n**Ready:** Join now!`, 
                inline: true 
            },
            { 
                name: '🏆 Your Team', 
                value: session.confirmedPlayers.map((id, index) => {
                    const user = interaction.guild.members.cache.get(id);
                    const userName = user ? user.displayName : 'Unknown';
                    const role = index === 0 ? '👑 Leader' : '⚔️ Member';
                    return `${role} **${userName}**`;
                }).join('\n'), 
                inline: false 
            }
        )
        .setFooter({ 
            text: `Session #${session.id.slice(-6)} • Have an amazing game!`,
            iconURL: interaction.guild.members.cache.get(session.creator)?.displayAvatarURL() || null
        })
        .setTimestamp();
    
    try {
        // Update the original message with finalized status
        await interaction.message.edit({ embeds: [embed], components: [] });
        console.log(`🎆 LFG Session ${session.id} finalized successfully - ${session.game} match ready!`);
    } catch (error) {
        console.error('Error updating finalized session message:', error);
    }
}

function parseDuration(durationStr) {
    const match = durationStr.match(/(\d+)([smhd])/);
    if (!match) return 60 * 60 * 1000; // Default 1 hour
    
    const [, amount, unit] = match;
    const num = parseInt(amount);
    
    switch (unit) {
        case 's': return num * 1000;
        case 'm': return num * 60 * 1000;
        case 'h': return num * 60 * 60 * 1000;
        case 'd': return num * 24 * 60 * 60 * 1000;
        default: return 60 * 60 * 1000;
    }
}

async function handleHelpCommand(interaction) {
    const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('🎮 LFG Bot - Help & Features')
        .setDescription('Find teammates, create parties, and organize your gaming sessions effortlessly!')
        .addFields(
            {
                name: '🎯 **LFG Commands**',
                value: '`/lfg <game> <gamemode> <players> [info]`\n• Create a Looking for Group session\n• Optional info field for extra details\n• Automatically creates private voice channels\n• Team confirmation system with buttons',
                inline: false
            },
            {
                name: '🛠️ **Staff Commands** (Permissions Required)',
                value: '`/setchannel <channel>` - Set LFG-only channel\n`/embed <title> <description> [color]` - Create embeds\n`/mod <action> <user> [reason] [duration]` - Moderation',
                inline: false
            },
            {
                name: '🎮 **Supported Games**',
                value: 'Valorant • Fortnite • Brawlhalla • The Finals\nRoblox • Minecraft • Marvel Rivals • Rocket League\nApex Legends • Call of Duty • Overwatch',
                inline: false
            },
            {
                name: '🔧 **Key Features**',
                value: '✅ **Private Voice Channels** - Only LFG participants can join\n✅ **Auto-Cleanup** - Empty channels delete after 1 minute\n✅ **Team Confirmation** - Players confirm/decline when teams fill\n✅ **Channel Restrictions** - Staff can limit LFG to specific channels\n✅ **Game Categories** - Organized by game type\n✅ **Smart Permissions** - Secure voice channel access',
                inline: false
            },
            {
                name: '📋 **How to Use LFG**',
                value: '1️⃣ Use `/lfg` with your game, mode, and player count\n2️⃣ Other players click "Join LFG" button\n3️⃣ When team is full, everyone gets pinged to confirm\n4️⃣ Confirmed players get access to private voice channel\n5️⃣ Voice channel auto-deletes when empty',
                inline: false
            },
            {
                name: '⚖️ **Moderation Actions**',
                value: '• `kick` - Remove user from server\n• `ban` - Ban user with message deletion\n• `mute` - Timeout user (e.g., 10m, 1h, 1d)\n• `unmute` - Remove timeout from user',
                inline: false
            }
        )
        .setFooter({ text: 'Need help? Contact server staff • Bot made for gaming communities' })
        .setTimestamp();
    
    await interaction.reply({ embeds: [embed], ephemeral: true });
}

// Helper functions for enhanced LFG experience
function createProgressBar(current, total, length = 12) {
    const filled = Math.round((current / total) * length);
    const empty = length - filled;
    const filledBar = '🟩'.repeat(filled);
    const emptyBar = '⬜'.repeat(empty);
    return `${filledBar}${emptyBar}`;
}

function getTimeAgo(timestamp) {
    const now = Date.now();
    const diff = now - timestamp;
    const minutes = Math.floor(diff / 60000);
    
    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    
    const hours = Math.floor(minutes / 60);
    return `${hours}h ago`;
}

function getExpiryTime(createdAt) {
    const expiry = new Date(createdAt + (20 * 60 * 1000)); // 20 minutes from creation
    return `in ${Math.max(0, Math.ceil((expiry - Date.now()) / 60000))}m`;
}

function getGameEmoji(gameName) {
    const gameEmojis = {
        'Valorant': '🔫',
        'Fortnite': '🏗️',
        'Apex Legends': '🎆',
        'Call of Duty': '🚁',
        'Overwatch': '🤖',
        'Rocket League': '⚽',
        'Minecraft': '🧺',
        'Roblox': '🎮',
        'Brawlhalla': '⚔️',
        'The Finals': '🏆',
        'Marvel Rivals': '⚡'
    };
    return gameEmojis[gameName] || '🎮';
}

// Function to handle member removal from all sessions (for moderation)
async function removeMemberFromAllSessions(memberId) {
    const affectedSessions = [];
    
    for (const [sessionId, session] of activeSessions) {
        if (session.currentPlayers.includes(memberId) || session.confirmedPlayers.includes(memberId)) {
            affectedSessions.push(sessionId);
            
            // Remove from players arrays
            session.currentPlayers = session.currentPlayers.filter(id => id !== memberId);
            session.confirmedPlayers = session.confirmedPlayers.filter(id => id !== memberId);
            
            // Remove voice access
            try {
                const guild = client.guilds.cache.get(session.guild);
                const voiceChannel = guild?.channels.cache.get(session.voiceChannel);
                if (voiceChannel) {
                    await voiceChannel.permissionOverwrites.delete(memberId);
                }
            } catch (error) {
                console.error('Error removing voice access during moderation:', error);
            }
            
            // If they were the creator, end the session
            if (session.creator === memberId) {
                try {
                    const guild = client.guilds.cache.get(session.guild);
                    const voiceChannel = guild?.channels.cache.get(session.voiceChannel);
                    if (voiceChannel) {
                        await voiceChannel.delete();
                    }
                } catch (error) {
                    console.error('Error deleting voice channel during moderation:', error);
                }
                
                activeSessions.delete(sessionId);
                userCreatedSessions.delete(memberId);
                console.log(`Ended session ${sessionId} - creator was moderated`);
            } else if (session.currentPlayers.length === 0) {
                // Session became empty, clean up
                try {
                    const guild = client.guilds.cache.get(session.guild);
                    const voiceChannel = guild?.channels.cache.get(session.voiceChannel);
                    if (voiceChannel) {
                        await voiceChannel.delete();
                    }
                } catch (error) {
                    console.error('Error deleting empty voice channel during moderation:', error);
                }
                
                activeSessions.delete(sessionId);
                userCreatedSessions.delete(session.creator);
                console.log(`Cleaned up empty session ${sessionId} after moderation`);
            } else {
                // Reopen session with remaining players
                await reopenLfg(session);
                console.log(`Reopened session ${sessionId} after removing moderated member`);
            }
        }
    }
    
    console.log(`Removed member ${memberId} from ${affectedSessions.length} LFG sessions due to moderation`);
}

async function handleLeaveLfg(interaction) {
    const sessionId = interaction.customId.replace('leave_lfg_', '');
    const session = activeSessions.get(sessionId);
    
    if (!session) {
        return interaction.reply({ content: '❌ This LFG session is no longer active!', flags: 64 });
    }
    
    if (!session.currentPlayers.includes(interaction.user.id)) {
        return interaction.reply({ content: '❌ You are not in this LFG session!', flags: 64 });
    }
    
    // Don't allow session creator to leave (they should use /endlfg instead)
    if (interaction.user.id === session.creator) {
        return interaction.reply({ 
            content: '❌ As the session creator, you cannot leave. Use `/endlfg` to end the entire session instead.', 
            flags: 64 
        });
    }
    
    try {
        // First reply to the interaction immediately to prevent timeout
        await interaction.reply({ content: '✅ You left the LFG session.', flags: 64 });
        
        // Remove user from session
        session.currentPlayers = session.currentPlayers.filter(id => id !== interaction.user.id);
        session.confirmedPlayers = session.confirmedPlayers.filter(id => id !== interaction.user.id);
        
        // Remove voice channel access
        try {
            const voiceChannel = interaction.guild.channels.cache.get(session.voiceChannel);
            if (voiceChannel) {
                await voiceChannel.permissionOverwrites.delete(interaction.user.id);
                // Disconnect if user is in the voice channel
                if (interaction.member.voice.channel?.id === session.voiceChannel) {
                    await interaction.member.voice.disconnect('Left LFG session');
                }
            }
        } catch (error) {
            console.error('Error removing voice channel access:', error);
        }
        
        console.log(`Player ${interaction.user.displayName} left session ${sessionId}`);
        
        // If session becomes empty, clean it up
        if (session.currentPlayers.length === 0) {
            try {
                const voiceChannel = interaction.guild.channels.cache.get(session.voiceChannel);
                if (voiceChannel) {
                    await voiceChannel.delete();
                }
            } catch (error) {
                console.error('Error deleting voice channel:', error);
            }
            activeSessions.delete(sessionId);
            userCreatedSessions.delete(session.creator); // Clean up creator tracking
            console.log(`Session ${sessionId} deleted - no players remaining`);
            return;
        }
        
        // Update the session embed and reopen for new joiners
        await reopenLfg(session);
        
    } catch (error) {
        console.error('Error in handleLeaveLfg:', error);
        // If interaction hasn't been replied to yet, send error message
        if (!interaction.replied && !interaction.deferred) {
            try {
                await interaction.reply({ 
                    content: '❌ There was an error processing your request. Please try again.', 
                    flags: 64 
                });
            } catch (replyError) {
                console.error('Error sending error reply:', replyError);
            }
        }
    }
}

async function handleEndLfgCommand(interaction) {
    const userId = interaction.user.id;
    
    // Find the user's active LFG session (where they are the creator)
    const userSession = Array.from(activeSessions.entries()).find(([sessionId, session]) => 
        session.creator === userId
    );
    
    if (!userSession) {
        return interaction.reply({ 
            content: '❌ You don\'t have an active LFG session to end!', 
            flags: 64 
        });
    }
    
    const [sessionId, session] = userSession;
    
    try {
        // Clear any timeouts
        if (session.timeoutId) {
            clearTimeout(session.timeoutId);
            session.timeoutId = null;
        }
        
        // Get guild and channel info
        const guild = client.guilds.cache.get(session.guild);
        const channel = guild?.channels.cache.get(session.channel);
        
        // Delete voice channel
        try {
            const voiceChannel = guild?.channels.cache.get(session.voiceChannel);
            if (voiceChannel) {
                await voiceChannel.delete();
                console.log(`Deleted voice channel for ended session ${sessionId}`);
            }
        } catch (error) {
            console.error('Error deleting voice channel:', error);
        }
        
        // Create ended embed
        const endedEmbed = new EmbedBuilder()
            .setColor(0x95a5a6) // Gray color
            .setTitle('🔚 LFG Session Ended')
            .setDescription(`${interaction.user.displayName} ended their LFG session.`)
            .setTimestamp();
        
        // Update original message if possible, or send new message if it fails
        if (channel) {
            let messageUpdated = false;
            
            try {
                if (session.messageId) {
                    const originalMessage = await channel.messages.fetch(session.messageId);
                    await originalMessage.edit({ embeds: [endedEmbed], components: [] });
                    console.log(`Updated original LFG message for ended session ${sessionId}`);
                    messageUpdated = true;
                } else {
                    // Fallback: try to find the message if no ID stored
                    const messages = await channel.messages.fetch({ limit: 50 });
                    const originalMessage = messages.find(msg => 
                        msg.embeds.length > 0 && 
                        msg.embeds[0].footer?.text?.includes(sessionId.slice(-6))
                    );
                    
                    if (originalMessage) {
                        await originalMessage.edit({ embeds: [endedEmbed], components: [] });
                        console.log(`Updated LFG message using fallback search for ended session ${sessionId}`);
                        messageUpdated = true;
                    }
                }
            } catch (error) {
                console.error('Error updating original message:', error);
                
                // If message fetch failed, try broader search to find and disable the button
                try {
                    const messages = await channel.messages.fetch({ limit: 100 });
                    const originalMessage = messages.find(msg => 
                        msg.embeds.length > 0 && 
                        msg.embeds[0].footer?.text?.includes(sessionId.slice(-6)) &&
                        msg.components.length > 0 &&
                        msg.components[0].components.some(comp => comp.customId?.includes(`join_lfg_${sessionId}`))
                    );
                    
                    if (originalMessage) {
                        await originalMessage.edit({ embeds: [endedEmbed], components: [] });
                        console.log(`Found and updated LFG message using extended search for ended session ${sessionId}`);
                        messageUpdated = true;
                    }
                } catch (secondError) {
                    console.error('Extended search also failed:', secondError);
                }
            }
            
            // If we couldn't update the original message, send a new one
            if (!messageUpdated) {
                try {
                    await channel.send({ embeds: [endedEmbed] });
                    console.log(`Sent new ended message for session ${sessionId} since original couldn't be updated`);
                } catch (sendError) {
                    console.error('Error sending new ended message:', sendError);
                }
            }
        }
        
        // Remove session from memory
        activeSessions.delete(sessionId);
        userCreatedSessions.delete(session.creator); // Clean up creator tracking
        
        console.log(`Session ${sessionId} ended by creator ${interaction.user.displayName}`);
        
        await interaction.reply({ 
            content: '✅ Your LFG session has been ended successfully!', 
            flags: 64 
        });
        
    } catch (error) {
        console.error('Error ending LFG session:', error);
        await interaction.reply({ 
            content: '❌ There was an error ending your LFG session. Please try again.', 
            flags: 64 
        });
    }
}

// Simple HTTP server for Render health checks
const http = require('http');
const port = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
        status: 'Bot is running!', 
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    }));
});

server.listen(port, () => {
    console.log(`Health check server running on port ${port}`);
});

// Add error handlers for Discord client
client.on('error', (error) => {
    console.error('Discord client error:', error);
});

client.on('shardError', (error, shardId) => {
    console.error(`Shard ${shardId} error:`, error);
});

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('Received SIGINT, shutting down gracefully...');
    client.destroy();
    server.close();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('Received SIGTERM, shutting down gracefully...');
    client.destroy();
    server.close();
    process.exit(0);
});

// Add global error handling
process.on('unhandledRejection', (error) => {
    console.error('Unhandled promise rejection:', error);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
    process.exit(1);
});

client.login(process.env.DISCORD_TOKEN);
}