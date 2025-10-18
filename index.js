import 'dotenv/config';
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
} from 'discord.js';

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

// Track per-message click sets (resets on restart—fine for interest signups)
const interestState = new Map(); // messageId -> { setup: Set<userId>, design: Set<userId> }

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // needed to assign roles
  ],
  partials: [Partials.GuildMember],
});

// ----- Register slash command (/choco) on startup -----
const commands = [
  {
    name: 'choco',
    description: 'Post the Chocolate 3D Printer interest buttons here',
  },
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
        body: commands,
      });
      console.log('Registered guild command /choco');
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log('Registered global command /choco (may take up to an hour to appear)');
    }
  } catch (err) {
    console.error('Command registration failed:', err);
  }
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands();
});

// ----- Helpers -----
async function getOrCreateRole(guild, roleName) {
  if (!roleName) return null;
  let role = guild.roles.cache.find(r => r.name === roleName);
  if (role) return role;

  // Create role if missing
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

  // Check bot can manage roles
  const botMember = await guild.members.fetchMe();
  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return { assigned: false, role: null, error: 'Bot lacks Manage Roles permission.' };
  }

  const role = await getOrCreateRole(guild, roleName);
  if (!role) return { assigned: false, role: null, error: `Could not get/create role "${roleName}".` };

  // Ensure bot role is higher than target role
  if (botMember.roles.highest.comparePositionTo(role) <= 0) {
    return { assigned: false, role, error: 'Move the bot’s role above the target role in Server Settings → Roles.' };
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

// ----- Interactions -----
client.on('interactionCreate', async (interaction) => {
  try {
    // Slash command: /choco
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'choco') {
        const embed = buildEmbed(0, 0);
        const row = buildButtons(false);
        const msg = await interaction.reply({ embeds: [embed], components: [row], fetchReply: true });
        interestState.set(msg.id, { setup: new Set(), design: new Set() });
      }
      return;
    }

    // Button clicks
    if (interaction.isButton()) {
      const [ns, type] = interaction.customId.split(':'); // 'choco:setup' or 'choco:design'
      if (ns !== 'choco' || !['setup', 'design'].includes(type)) return;

      // Get or init state for this message
      const msgId = interaction.message.id;
      if (!interestState.has(msgId)) {
        interestState.set(msgId, { setup: new Set(), design: new Set() });
      }
      const state = interestState.get(msgId);
      const set = type === 'setup' ? state.setup : state.design;

      set.add(interaction.user.id);

      // Assign role if configured
      const roleResult = await addRoleIfConfigured(interaction, type);

      // Optional DM
      if (String(AUTO_DM).toLowerCase() === 'true') {
        try {
          await interaction.user.send(
            type === 'setup'
              ? '🍫 Thanks! You’re on the **Chocolate Setup Team**. We’ll coordinate details in the server.'
              : '🎨 Awesome! You’re in **Chocolate Designers**. Feel free to share ideas in the server.'
          );
        } catch {
          // ignoring DM failures (privacy settings)
        }
      }

      // Update the embed footer with counts
      const updated = buildEmbed(state.setup.size, state.design.size);
      await interaction.message.edit({ embeds: [updated], components: [buildButtons(false)] });

      // Ephemeral confirmation
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

client.login(TOKEN);
