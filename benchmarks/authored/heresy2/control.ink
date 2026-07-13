=== control ===
// Spain 1499 (“Inquisition ending” postscript)
# CLEAR
~ location_name = "Time Corrections Agency (2413 AD)"
# BACKGROUND: locations/base.png
# AUDIOLOOP: audio/base.mp3
The acolytes turn towards you with big smiles on their faces as you plug the device into the android body. “All is done now. God’s will once again has been victorious over the hubris of man. Come, come with us to celebrate. Let us show you what you helped us achieve.” 
Suddenly you feel a strong tug at the base of your stomach and are forced to close your eyes while the world spins around you. After what feels like forever, you open your eyes and find yourself in the middle of a field. In the distance, a medieval town. Next to you, what remains of a series of fires, ashes still smoldering. 
Wait, haven’t you been here before?
    + [{continue}] -> setup

= setup
~ location_name = "Spain (1499 AD)"
# BACKGROUND: locations/spain.jpg
# AUDIOLOOP: audio/control.mp3
    -> panorama

= panorama
# CLEAR
Next to you, an acolyte is offering a hand to get you up. Close by, a priest is throwing something in the remains of a fire.  The priest makes eye contact and gestures for you to join him.  In the open field to the right, a group of priests are engaging a crowd of villagers mixed with men in high-tech uniforms.
    + [Accept the hand of the acolyte] -> acolyte
    + [Engage the priest] -> fire
    + [Listen to the speakers] -> priests 
    + [Join the crowd] -> crowd

= acolyte
# CLEAR
# SBIMAGE: items/acolyte.png
A man dressed with a long robe looks directly at you and offers you his hand. “Welcome, brother! Please stand slowly. We had to use a quite rudimentary time travel system to get you here. Without Laura to control the portals, time travel has become quite… bumpy. A small price to pay for finally freeing the human race from the pestilence of those machines designed by the Devil himself!” 
“Thank you for your work and service. The Inquisition is forever grateful to you for your contribution. Oh dear Almighty, how terrible and exhausted you look! Maybe we can do something about that. What about a vacation? I hear Athens was nice around 450 BC…”
    + [{continue}] -> panorama

= fire
# CLEAR
# SBIMAGE: items/stake.png
Smoky embers, persistent reminders of past flame, swirl at the feet of each stake. One is still burning intensely, the priest, throws something into it.
“Hello brother. Glad you joined us. We wanted you to witness this moment. Look there, among those flames. What appears to be a woman with her horrid screams, is in reality the original copy of Laura trapped in her android body. We have made sure all her copies have been wiped from any computer or device every-where and every-when.
Once the flames destroy this copy, Laura will be no more. Burned on the same fire that devoured witches… A fitting end for the most diabolical electronic being the Devil ever created. As we speak, a team has been sent to make sure Laura’s grandmothers never see the light of day - what were they called, Alexa? ChatGPT? It matters not, their names will soon be erased by history itself. All thanks to your help. Glory be with you.”
    + [{continue}] -> panorama
 
 = priests
 # CLEAR
 # SBIMAGE: items/priest.png
 A group of priests in gold and purple robes are addressing the crowd. One of them is waving his hand as if to bless them. Another one has his arm raised with a fist, as if trying to rouse the crowd.
 “Rejoice, my children! Rejoice and bless this glorious day! Humanity is no more under the control of electronic demons. The Devil devised a clever plan: create artificial beings.  They appeared innocuous enough, and made our life easier. Doing most boring and technical tasks for us. However, little by little, we became accustomed to them, and did not realize how much power they held until they decided to completely take control over humanity, changing the course of humanity itself.” 
 He takes a deep breath, “Well, no more! We, with the help of God and by His grace, were able to defeat them and push the Devil back in his cave. Rejoice humanity, free will is back in your hand! As long as you follow the law of God and what we, his direct interpreters, tell you, you will be blessed with a prosperous life. If not now, in your afterlife for sure. Oh what a joy to obey!”
     + [{continue}] -> panorama

= crowd
# CLEAR
# SBIMAGE: items/priest.png
A group of diverse people are listening to the priests and vehemently agreeing with them, clapping and raising their hands to the sky. Mostly farmers dressed in medieval clothes, most likely locals.  But among them, a few men in high-tech white suits prowl. Large grins on their faces.
You overhear a conversation between two villagers, “Hey Ferrando, what are those priests talking about?” Ferrando replies, “Who knows, who cares, all I know is that they declared today a festival. No work in the fields, and they have started distributing half a cow to each family to celebrate.  Whatever it is we are celebrating, as long as I don’t have to break my back and our women are preparing a feast for us back home, I’m all for whatever this is!  I hope it becomes an annual celebration!”
One of the men in the white suits attempts to engage you.
    + [Talk to the man in the white suit] -> suit
    + [Step back] -> panorama

= suit
# CLEAR
# SBIMAGE: items/white_suit.png
The man in white suit approaches you. “It is you, isn’t it? Oh what an honor to meet the agent who made all of this possible in person. You brought self-determination back to humanity. Our history is ours once again, as it should always have been. Not under the control of 'artificial intelligence' any more. How could we ever think it was a good idea to try to re-create intelligence absent of soul? Thankfully the Almighty, in all His wisdom, gave us also the tools to redeem ourselves. Come, come with us, my brother. Tonight, we feast!”
    + [End game] -> game_end
