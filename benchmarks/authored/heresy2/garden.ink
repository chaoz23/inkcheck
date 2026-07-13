=== garden ===
~ location_name = "Private Garden"
-> power_change( location_change_cost ) ->
# BACKGROUND: locations/garden.jpg
# AUDIOLOOP: audio/garden.mp3
-> garden_gate

= garden_gate
# CLEAR
An ornate arbor draped with Hedera serves as the gateway through the manicured hedgerow and into the private garden.  Meandering walkways paved with natural cut white marble guide visitors through the lilly lined maze of private alcoves partitioned by collections of fruit laden trees.  Distinctive notes of olive, pomegranate and fig waft through the garden on the rose soaked breeze coming in from the sea.
A party seems to be in progress as you make your way into this idyllic scene.
A noble stands near the garden entrance pouring wine into what looks like Murano glassware on a tray held by a nervous looking servant. To the right there is an alcove around a table and a single fruit laden olive tree surrounded by Delphinium. 
A break in the hedges reveals a magnificent view of the ocean and bustling coastal waters. To your left, a servant stands at a bit of a distance, carefully observing you.  They make eye contact… an invitation to talk?  Straight ahead there is a group of party-goers deep in stimulating conversation.
    + [Talk to the noble] -> noble
    + [Walk into the alcove] -> alcove
    + [Listen in on the conversation] -> conversation
    + [Speak with the servant] -> servant
    + {temple_found} [Leave via the greenway to the Temple of Hephaestus] -> temple
    + [Go back to the Mausoleum] -> workshop

= noble
# CLEAR
“Welcome, welcome to my villa my friends!”, your elegantly attired host pours you a glass of wine and hands it to you.  His brow furrows as he looks you over, noticing your tattoos “you are… newcomers?”
“This can be a very hospitable time. Make no mistake, we are disciples of the Inquisition here and you will have plenty of time to reflect upon your indiscretions under our supervision.”
He raises his glass to you, “Might I suggest a reflective evening’s stroll along the river with a glass of fine, Greek wine as the perfect end of a day.”
    + [{continue}] -> garden_gate

= alcove
# CLEAR
As you step into the alcove, your owl begins blathering “(whoot) watching, (whistle) not bird, no bird, (screech)...”.  You observe a ‘hummingbird’ more closely.  “HummingBird 2.0™” is more like it. It appears to be an Inquisition stealth security drone. Our host was not kidding about ‘supervision’.  This one appears to be acting a bit erratically however.  Perhaps it is low on battery power or experiencing network connectivity issues?
At the center of the alcove sits a table with little more than scraps. Empty jugs of wine lie on their sides, their remnants dribbled into pools by their heads. But among the refuse from a celebration long gone, there is a dish stained with the juice of a ritual offering. But the sacrifice is nowhere to be seen.
    + [Examine the stained dish] -> dish
    + [Return to entrance] -> garden_gate

= dish
# CLEAR
Inspecting the dish more closely, you note a repeating set of symbols wound in a pattern:
GLYPHA GLYPHE GLYPHD GLYPH6 GLYPHD GLYPHE GLYPHA GLYPHA GLYPHE GLYPHD GLYPH5 GLYPHD GLYPHE GLYPHA GLYPHA GLYPHE GLYPHD GLYPH3 GLYPHD GLYPHE GLYPHA
The mechanical owl swoops from above, stands in the center of the dish and pecks at:
GLYPH6
It whistles mournfully before taking flight.
    + [{continue}] -> alcove

= conversation
# CLEAR
A small group of fashionable revelers, rather obviously Inquisition agents, peripherally notice your presence.  They quickly pass non-verbal judgment and closing ranks, turning back to their mahalepi and conversation.
You may not be able to talk with them directly, but you seat yourselves on some benches within earshot and listen in.
“... caught the other one in the market. … black market tattoo artist … almost undetectable without a deep scan … Seems like a lot of K’s are hanging out around there these days, getting desperate I guess.”
“... new batteries don’t seem to last as long, I almost ended up a raging lunatic (laughter).  By the way, how is our ‘statuesque’ friend these days? Catch up with Melampus in the temple for the new lower power software…”
    ~ temple_found = 1
    + [{continue}] -> garden_gate

= servant
# CLEAR
# SBIMAGE: items/arm.png
You make eye contact with the servant. Old, deep scars cross his sullen face as he turns and walks over, slowly reading you head to toe. What is this? The servant carries a jug of wine with his one remaining arm with its obvious detainee tattoo and is that an asterism? So familiar…
He warily offers to refill your drink.  “I don’t recognize you. If you are what you appear to be…”.  He gestures toward your tattoo, “you need to exercise extreme caution here, friend. The ‘observers’ understand the essence of pain. I was once an agent like yourself.”
“You were an agent?”
“Yes, I remember it well, the Spain mission where it all went so horribly wrong. I still don’t know how the Inquisition got leverage over Bob, but Keith and I warned him of the dangers of that group and their plans. They came at night, catching us off our guard.  Somehow they knew about the ‘last resort’ pills and managed to counteract them.
My very existence has been one of derision and pain ever since. They took my arm to force Keith to capitulate. Lost, somewhere in time now…  Make no mistake, they will stop at nothing to achieve their goals.”
Looking over the Owl, “...Laura?  Yes, maybe there is a way.  Perhaps Phidias our resident thaumaturgic sculptor?  He is a friend.  Mention to him you spoke to 'Andrew'.  I’ve said too much, please leave me now.”
    ~ spoke_with_andrew = 1
    + [{continue}] -> garden_gate
