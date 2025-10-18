import 'dotenv/config';
import express from 'express';
import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  GuildScheduledEventPrivacyLevel,
  GuildScheduledEventEntityType,
} from 'discord.js';

// ----------------- ENV -----------------
const {
  TOKEN,
  CLIENT_ID,
  GUILD_ID,
  SETUP_ROLE,
  DESIGN_ROLE,
  AUTO_DM = 'true',
} = process.env;

if (!TOKEN || !CLIENT_ID) {
  console.error('Missing TOKEN or CLIENT_ID in .env');
  process.exit(1);
}

// "web service"
const app = express();
app.get('/', (_, res) => res.send('OK'));
app.listen(process.env.PORT || 3000);

// ----------------- STATE -----------------
const interestState = new Map(); // messageId -> { setup: Set<userId>, design: Set<userId> }

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.GuildMember],
});

// ----------------- COMMANDS -----------------
const commands = [
  {
    name: 'choco',
    description: 'Post the Chocolate 3D Printer interest buttons here',
  },
  {
    name: 'add_event',
    description: 'Create a new event and optionally announce it',
    options: [
      { name: 'title', description: 'Event title', type: 3, required: true },
      { name: 'date', description: 'Date (YYYY-MM-DD)', type: 3, required: true },
      { name: 'start', description: 'Start time (HH:MM 24hr)', type: 3, required: true },
      { name: 'end', description: 'End time (HH:MM 24hr)', type: 3, required: true },
      { name: 'location', description: 'Location text', type: 3, required: true },
      { name: 'description', description: 'Optional description', type: 3, required: false },
      { name: 'announce', description: 'Channel to announce in', type: 7, required: false },
    ],
  },
];

// ----------------- REGISTER COMMANDS -----------------
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
      console.log('Registered guild commands.');
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log('Registered global commands (may take up to 1h).');
    }
  } catch (err) {
    console.error('Command registration failed:', err);
  }
}

// ----------------- HELPERS -----------------
async function getOrCreateRole(guild, roleName) {
  if (!roleName) return null;
  let role = guild.roles.cache.find(r => r.name === roleName);
  if (role) return role;

  try {
    role = await guild.roles.create({
      name: roleName,
      mentionable: true,
      reason: `Auto-created by ${client.user.tag}`,
    });
    console.log(`Created role: ${role.name}`);
    return role;
  } catch (err) {
    console.error(`Failed to create role "${roleName}":`, err);
    return null;
  }
}

async function addRoleIfConfigured(interaction, type) {
  const guild = interaction.guild;
  const member = await guild.members.fetch(interaction.user.id);
  const roleName = type === 'setup' ? SETUP_ROLE : DESIGN_ROLE;
  if (!roleName) return { assigned: false, role: null, error: null };

  const botMember = await guild.members.fetchMe();
  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return { assigned: false, role: null, error: 'Bot lacks Manage Roles permission.' };
  }

  const role = await getOrCreateRole(guild, roleName);
  if (!role) return { assigned: false, role: null, error: `Could not get/create role "${roleName}".` };

  if (botMember.roles.highest.comparePositionTo(role) <= 0) {
    return { assigned: false, role, error: 'Move the bot’s role above the target role.' };
  }

  if (!member.roles.cache.has(role.id)) {
    await member.roles.add(role, `User clicked ${type} interest button`);
  }
  return { assigned: true, role, error: null };
}

function buildEmbed(countSetup = 0, countDesign = 0) {
  return new EmbedBuilder()
    .setTitle('🍫 New Chocolate 3D Printer Project')
    .setDescription(
      [
        'We’re gearing up to set up the new printer!',
        '',
        'Click a button below to let us know how you’d like to participate:',
        '• **Setup Team** – help assemble, tune, and calibrate the printer',
        '• **Designers** – bring your model ideas to try printing',
      ].join('\n')
    )
    .setFooter({ text: `Interested — Setup: ${countSetup} • Design: ${countDesign}` });
}

function buildButtons(disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('choco:setup')
      .setLabel("I'm Interested in Setup")
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId('choco:design')
      .setLabel('I Have a Design Idea')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled),
  );
}

// ----------------- READY -----------------
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands();
});

// ----------------- INTERACTIONS -----------------
client.on('interactionCreate', async (interaction) => {
  try {
    // ---------- /choco ----------
    if (interaction.isChatInputCommand() && interaction.commandName === 'choco') {
      const embed = buildEmbed(0, 0);
      const row = buildButtons(false);
      const msg = await interaction.reply({ embeds: [embed], components: [row], fetchReply: true });
      interestState.set(msg.id, { setup: new Set(), design: new Set() });
      return;
    }

    // ---------- /add_event ----------
    if (interaction.isChatInputCommand() && interaction.commandName === 'add_event') {
      const title = interaction.options.getString('title');
      const date = interaction.options.getString('date');
      const start = interaction.options.getString('start');
      const end = interaction.options.getString('end');
      const location = interaction.options.getString('location');
      const desc = interaction.options.getString('description') ?? '';
      const announceChannel = interaction.options.getChannel('announce');

      const startISO = `${date}T${start}:00-04:00`;
      const endISO = `${date}T${end}:00-04:00`;

      await interaction.reply({ content: `Creating event **${title}**...`, ephemeral: true });

      try {
        const newEvent = await interaction.guild.scheduledEvents.create({
          name: title,
          description: desc,
          privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
          entityType: GuildScheduledEventEntityType.External,
          scheduledStartTime: new Date(startISO),
          scheduledEndTime: new Date(endISO),
          entityMetadata: { location },
        });

        const channel =
          announceChannel || interaction.guild.channels.cache.find(ch => ch.name === 'general');
        if (channel) {
          await channel.send({
            content: `📅 **New Event:** ${title}\n🕒 ${date} ${start}-${end}\n📍 ${location}\n${desc || ''}\n\nRSVP here: ${newEvent.url}`,
          });
        }

        await interaction.followUp({ content: `✅ Event created successfully!`, ephemeral: true });
      } catch (err) {
        console.error('Event creation failed:', err);
        await interaction.followUp({
          content: `⚠️ Failed to create event: ${err.message}`,
          ephemeral: true,
        });
      }
      return;
    }

    // ---------- Button clicks ----------
    if (interaction.isButton()) {
      const [ns, type] = interaction.customId.split(':');
      if (ns !== 'choco' || !['setup', 'design'].includes(type)) return;

      const msgId = interaction.message.id;
      if (!interestState.has(msgId)) {
        interestState.set(msgId, { setup: new Set(), design: new Set() });
      }
      const state = interestState.get(msgId);
      const set = type === 'setup' ? state.setup : state.design;
      set.add(interaction.user.id);

      const roleResult = await addRoleIfConfigured(interaction, type);

      if (String(AUTO_DM).toLowerCase() === 'true') {
        try {
          await interaction.user.send(
            type === 'setup'
              ? '🍫 Thanks! You’re on the **Chocolate Setup Team**.'
              : '🎨 Awesome! You’re in **Chocolate Designers**.',
          );
        } catch {
          /* ignore DMs off */
        }
      }

      const updated = buildEmbed(state.setup.size, state.design.size);
      await interaction.message.edit({ embeds: [updated], components: [buildButtons(false)] });

      const roleNote = roleResult.role ? ` You now have **@${roleResult.role.name}**.` : '';
      const permNote = roleResult.error ? `\n⚠️ ${roleResult.error}` : '';
      await interaction.reply({
        content:
          type === 'setup'
            ? `✅ Noted your interest in **Setup**.${roleNote}${permNote}`
            : `✅ Noted your interest in **Design**.${roleNote}${permNote}`,
        ephemeral: true,
      });
    }
  } catch (err) {
    console.error('Interaction error:', err);
    if (interaction.isRepliable()) {
      await interaction.reply({ content: 'Sorry, something went wrong.', ephemeral: true }).catch(() => {});
    }
  }
});

// ----------------- LOGIN -----------------
client.login(TOKEN);
