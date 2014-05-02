"use strict";
/*global setImmediate: true*/

var base = require("xbase"),
	fs = require("fs"),
	C = require("C"),
	libxmljs = require("libxmljs"),
	path = require("path"),
	runUtil = require("xutil").run,
	fileUtil = require("xutil").file,
	rimraf = require("rimraf"),
	glob = require("glob"),
	tiptoe = require("tiptoe");

if(process.argv.length<3 || !fs.existsSync(process.argv[2]))
{
	base.error("Usage: node generate.js /path/to/base-Win.MPQ");
	process.exit(1);
}

var MPQ_ORIGINAL_PATH = process.argv[2];
var MPQ_FILE_NAME = "base-Win.MPQ";
var OUT_PATH = path.join(__dirname, "out");
var CARDXML_FILE_NAME = "cardxml0.unity3d";
var CARDXML_DIR_NAME = path.basename(CARDXML_FILE_NAME, path.extname(CARDXML_FILE_NAME));
var MPQEDITOR_PATH = path.join(__dirname, "MPQEditor.exe");
var DISUNITY_PATH = path.join(__dirname, "disunity", "disunity.sh");

tiptoe(
	function clearOut()
	{
		base.info("Clearing 'out' directory...");
		rimraf(OUT_PATH, this);
	},
	function createOut()
	{
		fs.mkdir(OUT_PATH, this);
	},
	function copyMPQ()
	{
		base.info("Copying MPQ to 'out' directory...");
		fileUtil.copy(MPQ_ORIGINAL_PATH, path.join(OUT_PATH, MPQ_FILE_NAME), this);
	},
	function extractMPQ()
	{
		base.info("Extracting MPQ...");
		runUtil.run("wine", [MPQEDITOR_PATH, "/extract", path.join("out", MPQ_FILE_NAME), "Data\\Win\\" + CARDXML_FILE_NAME, "out"], {cwd:__dirname, silent : true}, this);
	},
	function extractCardXMLIfNeeded()
	{
		base.info("Extracting card XML...");
		runUtil.run(DISUNITY_PATH, ["-c", "extract", CARDXML_FILE_NAME], {cwd:OUT_PATH, silent : true}, this);
	},
	function getCards()
	{
		base.info("Finding card XML...");
		glob(path.join(OUT_PATH, CARDXML_DIR_NAME, "TextAsset", "*.txt"), this);
	},
	function processCards(files)
	{
		base.info("Processing card XML...");
		C.LANGUAGES.serialForEach(function(language, cb)
		{
			files.serialForEach(function(file, subcb) { processCard(file, language, subcb); }, cb);
		}, this);
	},
	function saveSets(cards)
	{
		base.info("Saving JSON...");

		C.LANGUAGES.serialForEach(function(language, cb, i)
		{
			saveSet(cards[i], language, cb);
		}, this);
	},
	function cleanup()
	{
		base.info("Cleaning up...");
		fs.unlink(path.join(OUT_PATH, MPQ_FILE_NAME), this.parallel());
		fs.unlink(path.join(OUT_PATH, CARDXML_FILE_NAME), this.parallel());
		rimraf(path.join(OUT_PATH, CARDXML_DIR_NAME), this.parallel());
	},
	function finish(err)
	{
		if(err)
		{
			base.error(err);
			process.exit(1);
		}

		process.exit(0);
	}
);

function saveSet(cards, language, cb)
{
	var sets = {};

	base.info("Saving %d cards for language: %s", cards.length, language);

	cards.forEach(function(card)
	{
		var cardSet = card.set;
		if(!sets.hasOwnProperty(cardSet))
			sets[cardSet] = [];
		sets[cardSet].push(card);
	});

	tiptoe(
		function saveFiles()
		{
			Object.forEach(sets, function(setName, cards)
			{
				fs.writeFile(path.join(OUT_PATH, setName + "." + language + ".json"), JSON.stringify(cards.sort(function(a, b) { return a.name.localeCompare(b.name); })), {encoding:"utf8"}, this.parallel());
			}.bind(this));
		},
		function finish(err)
		{
			return setImmediate(function() { cb(err); });
		}
	);
}

function processCard(cardXMLPath, language, cb)
{
	var card = {};

	tiptoe(
		function loadFile()
		{
			fs.readFile(cardXMLPath, {encoding:"utf8"}, this);
		},
		function processFile(cardXMLData)
		{
			var xmlDoc = libxmljs.parseXml(cardXMLData);
			var Entity = xmlDoc.get("/Entity");

			card.id = Entity.attr("CardID").value();
			card.name = getTagValue(Entity, "CardName", language);
			card.set = getTagValue(Entity, "CardSet", language);
			card.type = getTagValue(Entity, "CardType", language);
			card.faction = getTagValue(Entity, "Faction", language);
			card.rarity = getTagValue(Entity, "Rarity", language);
			card.cost = getTagValue(Entity, "Cost", language);
			card.attack = getTagValue(Entity, "Atk", language);
			card.health = getTagValue(Entity, "Health", language);
			card.durability = getTagValue(Entity, "Durability", language);
			card.text = getTagValue(Entity, "CardTextInHand", language);
			card.inPlayText = getTagValue(Entity, "CardTextInPlay", language);
			card.flavor = getTagValue(Entity, "FlavorText", language);
			card.artist = getTagValue(Entity, "ArtistName", language);
			card.collectible = getTagValue(Entity, "Collectible", language);
			card.elite = getTagValue(Entity, "Elite", language);
			card.race = getTagValue(Entity, "Race", language);
			card.playerClass = getTagValue(Entity, "Class", language);
			card.howToGet = getTagValue(Entity, "HowToGetThisCard", language);
			card.howToGetGold = getTagValue(Entity, "HowToGetThisGoldCard", language);

			Object.keys(card).forEach(function(key)
			{
				if(card[key]===undefined)
					delete card[key];
			});

			this();
		},
		function finish(err)
		{
			if(err)
				base.error("Error for card: " + card.name);

			setImmediate(function() { cb(err, card); });
		}
	);
}

function getTagValue(Entity, tagName, language)
{
	var Tag = Entity.get("Tag[@name='" + tagName + "']");
	if(!Tag)
		return undefined;

	var type = Tag.attr("type").value();
	if(type==="String")
	{
		var stringTag = Tag.get(language);
		if(!stringTag)
			stringTag = Tag.get("enUS");
		return stringTag.text().trim();
	}

	var value = Tag.attr("value").value();

	if(!TAG_VALUE_MAPS.hasOwnProperty(tagName))
	{
		if(type==="Number")
			return +value;

		if(type==="Bool")
			return value==="1" ? true : false;

		throw new Error("Unhandled Tag type [" + type + "]");
	}

	var tagMap = TAG_VALUE_MAPS[tagName];
	if(!tagMap.hasOwnProperty(value))
		throw new Error("Unknown " + tagName + ": " + value);

	return tagMap[value];
}

var TAG_VALUE_MAPS =
{
	"CardSet" :
	{
		2 : "Basic",
		3 : "Expert",
		4 : "Reward",
		5 : "Missions",
		7 : "System",
		8 : "Debug",
		11 : "Promotion",
		16 : "Credits"
	},
	"CardType" :
	{
		3 : "Hero",
		4 : "Minion",
		5 : "Spell",
		6 : "Enchantment",
		7 : "Weapon",
		10 : "Hero Power"
	},
	"Faction" :
	{
		1 : "Horde",
		2 : "Alliance",
		3 : "Neutral"
	},
	"Rarity" :
	{
		1 : "Common",
		2 : "Free",
		3 : "Rare",
		4 : "Epic",
		5 : "Legendary"
	},
	"Race" :
	{
		14 : "Murloc",
		15 : "Demon",
		20 : "Beast",
		21 : "Totem",
		23 : "Pirate",
		24 : "Dragon"
	},
	"Class" :
	{
		2 : "Druid",
		3 : "Hunter",
		4 : "Mage",
		5 : "Paladin",
		6 : "Priest",
		7 : "Rogue",
		8 : "Shaman",
		9 : "Warlock",
		10 : "Warrior",
		11 : "Dream"
	}
};
