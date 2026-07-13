=== river ===
~ location_name = "Eridanos Stream"
# BACKGROUND: locations/river.jpg
# AUDIOLOOP: audio/river.mp3
-> power_change( location_change_cost ) ->
-> panorama

= panorama
# CLEAR
A lazy river appears in front of you. The sun rays playfully bounce off its waters, making it look like a shimmery bed of milk and honey. On the left, a path leads down to the water's edge. {not simple_battery: In the middle a muscular man strumming a few notes from a lute. } {lute and not simple_battery: On the right, a beautiful girl with sad eyes is hiding behind a tree.}
    + [Walk down the path] -> pathway
    + {not simple_battery} [Listen to the lute] -> lute
    + {lute and not simple_battery} [Talk to the girl] -> girl
    + [Head back up the hill to the Pnyx] -> pnyx

= pathway
# CLEAR
A narrow, gravel strewn path wanders along the river.  A variety of trees and lush vegetation line the way. A large boulder to one side protects a small open area with a view of the river.  A most peaceful spot as shafts of light pierce air heavily laden with floral scents.
{crutch and stole_crutch: Aspasia is here, resting against the boulder.  Her faces tightens into a mask of disgust as she becomes aware of your approach.}
A small bench can be seen further down the path.
    + {crutch and stole_crutch} [Return the crutch to Aspasia] -> return_crutch
    + [Use the bench to relax] -> bench
    + [Head back toward the entrance] -> panorama

= return_crutch
Aspasia spits in front of you as you come into view, “Looking to return to the good graces of Zeus? Very well, but I never want to see you again!” and she awkwardly ambles away.
    ~ crutch = 0
    + [{continue}] -> pathway

= bench
# CLEAR
You sit on the bench to enjoy the view and the fresh breeze on your face. You close your eyes slightly to better take in the moment… and that is when you see with the corner of your eyes a bit of folded pergamen laying on the ground next to you. You pick it up and unfold it:
# CLASS: writing
# IMAGE: items/delphic.png
“This is day 3 of this iteration. How many iterations has it been already? I’ve lost count. Bob has most certainly found an ironic way to make a paradise into a new hell… His new friends must have taught him a thing or two about the Divine Comedy. Or maybe he watched Groundhog day one too many times? Smart man, managing to not break any 'life preservation' laws while forever making his enemies harmless. Somebody help, I feel I’m about to lose my mind. Anything would be better than this so-called life.”
{not apollo_backroom_keycode: A digital keycode is attached to the letter.  You pocket it for future reference.}
    ~ apollo_backroom_keycode = 1
    + [Head back toward the entrance] -> pathway

= lute
# CLEAR
A muscular man sitting on a rock, playing the lute. “Oh, my sweet sweet Daphne, why do you like to pull the strings of my poor heart? Come back to me, my sweet muse, and untwine them once again with your gracious sight, and all will be forgiven. Your painful words and actions are just a way to get me to love you even more, I know that. And I will never let them pull us apart. Where are you, my sweet nympha?”
He suddenly sees you, and his demeanor changes completely. “Who are you, a love competitor? What have you done with my Daphne?”
    + [Continue walking the stream] -> panorama

= girl
# CLEAR
A beautiful girl with long hair and a short dress hides behind a tree. Her eyes point toward you with a look of terror.
“Gentle stranger, please help me! Apollo cannot take no as an answer. I tried to let him down nicely, I tried to be gentle, I tried the firm way, but nothing seems to convince him that between us it really is over! I need to get away from him as soon as possible. Please, please help  me!”
    + [We should hide from him] -> hide_her
    + [We should show him you have a new lover] -> love_her
    + [I'm sorry, I cannot get involved] -> panorama

= hide_her
# CLEAR
~ combat_health = 90.
~ combat_attack = 10.
~ combat_defense = 25.
You find a large bush and tell Daphne to crouch behind it. Then, you please a few leaves and branches in front of her while footsteps are approaching. It’s Apollo coming your direction. You think you did a good job, but it’s hard to fool a paranoid lover.
“Daphne what is going on? Why are you sitting there? And who is this person? Did they make you hide from me? Are they trying to steal you from me? Or are they trying to kidnap you? How DARE YOU!” With irrational rage, Apollo charges at you. Daphne jumps out of the bushes to try to pull him away from you.
    + [You have no choice but to confront him] -> fight

= fight
// Note: you basically cannot 'win' this fight.  You are doomed to 'lose', but Daphne steps in...
# CLEAR
Apollo attempts to grapple with you, though you can tell his heart is not in it.
    ~ temp combat_result = 0
    -> combat("Apollo", combat_result) ->
    { combat_result == 1:
        // you win
        -> victory
    - else:
        // Daphne may step in if you take some damage
        { exo_power < 80:
            -> loss
        }
    }
    + [He won't stop...] -> fight

= victory
# SBIMAGE: locations/apollo_statue.png
With your last punch, Apollo is finally out of breath. He turns his head towards you with a look of pure surprise. Your punch has dislodged his battery unit, and he quickly turns into a statue. You calmly pick up the battery from the ground. This might turn out to be useful…
    ~ simple_battery = 1
    + [Walk the stream] -> panorama

= loss
# SBIMAGE: locations/lovers.png
You’re out of breath, fighting Apollo isn’t a walk in the park. But just when you think there’s no way for you to win, he turns toward Daphne and tries to grab her. Desperate to make him stop, she grabs his battery pack and rips it out of its pouch. But in the heat of this last attempt, she does not realize her energies are all drained. She has no more power to keep going... Two ex-lovers eternally captured in stone.
    ~ simple_battery = 1
    ~ apollo_and_daphne = 1
    + [Walk the stream] -> panorama

= love_her
# CLEAR
# SBIMAGE: locations/lovers.png
you two start holding hands while whispering in each other’s ears. You can hear Apollo’s footsteps approaching, while your heart beats louder and louder, and the fear of his reaction makes your knees go weak. Why did you agree to this silly plan, will it even work? Finally, Apollo turns a corner and sees the two of you. He immediately freezes on his step.
“Oh, is that you? Sorry, we didn’t hear you coming” giggles Daphne “See, when I told you we had grown too apart for each other… this is what I meant”
The look of defeat in Apollo’s eyes almost makes you feel almost sorry for him. You turn away, relieved that he took the news with no further action. Daphne, shocked by his action begins to weep uncontrollably. “No! No! This is not what I wanted! I've made a terrible mistake and must...change...”  And with that exclamation she runs off into the trees to him. 
Suddenly you hear him scream “Oh cruel destiny!” and nothing more. You run back, and find them embodied in 'stone'.  Daphne, her transformation half complete and Apollo, reaching her from behind as he ripped his battery pack out in angst. Lovers, forever captured in stone.  You sigh and pick the battery up from the ground.
    ~ simple_battery = 1
    ~ apollo_and_daphne = 1
    + [Walk the stream] -> panorama
