=== hypermarket ===
~ location_name = "HyperMarket Redux"
# BACKGROUND: locations/hypermarket.jpg
# AUDIOLOOP: audio/hypermarket.mp3
-> power_change( location_change_cost ) ->
# CLEAR
# AUDIO: audio/transport.mp3
An odd sense of déjà vu washes over you. Have we been here before? You stand before a large, box-like structure with an advertisement covered facade announcing incredible deals found inside. As you enter, you notice the symbol 
# IMAGE: items/tattoo.png
decorating workers’, oddly hooded uniforms.  15th century Spanish clergy if memory serves.
“He is so close now,” Laura exclaims, “We must find Keith and get him to the Time Corrections Agency base.  He can help us understand what is going on here and how it can be fixed.  I can feel his presence, but we must proceed with caution.”
    + [{continue}] -> panorama

= panorama
# CLEAR
The interior is a vast, open space with high ceilings and rows of shelves stocked with various goods. The air is filled with the hum of fluorescent lights and the faint sound of 'Bad Day' playing in the background.  A large sign hangs from the ceiling, reading "HyperMarket - Everything You Need. All in One Place!", but there are no shoppers, just workers busily collecting items. 
{ not soulgem_full and not item_poloshirt: “We are going to need to find something to get Keith's attention”, Laura notes. “Your previous encounter with him left him rather paranoid.  Perhaps something that would be familiar to him would help…”}
    + [Apparel section] -> apparel
    + [Clothing racks] -> racks
    + [Deli counter] -> deli
    + [Garden center] -> gardening
    + [Return to the Apollo computer room] -> apollo_backroom

= apparel
# CLEAR
~ combat_health = 30.
~ combat_attack = 10.
~ combat_defense = 25.
The apparel department walls are adorned with posters advertising the latest fashion trends, and the air is filled with the scent of fresh fabric.  A large sign comments, "Dress to Impress!". In the corner, a garment alteration station is set up with a sewing machine and various fabrics.
{ apparel_workers == 0:
    // Not yet met guys
    Two hooded figures stand in front of tables of unreasonably comfortable clothing at reasonable prices. You can’t see their faces. One is holding a strange device that looks like a gun but has too many barrels pointing in unusual angles. The other is holding up a pair of sweatpants for inspection. 
    “I don’t know…” one says while holding up the sweatpants, “We must wear the uniform, sure. But do you think they care what we have on under the robe?” The other shrugs. As you draw near, “I recognize you not, friend. What is your business here?”
    + {hypermarket_id} [Pretend to be a clerk using your ID] -> fake_clerk
    + [Ask to see their IDs] -> fight_pair
}
{ apparel_workers == 1:
    // you bribed them, they left
    The apparel department is empty, tables of clothing still neatly arranged.  A sign reads, "Uniforms available for purchase. Ask a clerk for assistance."
}
{ apparel_workers == 2:
    // you won the fight, but did not drain them
    The two hooded figures lie unconscious on the floor, their strange device and sweatpants lie around them. They are still breathing, but you can’t tell if they will wake up soon or not.
    {soulgem_empty:
        Laura gestures at your empty Soul Gem, “Keith used filled soul gems to power time portals in the past.  Given the pair here, we could filled a Soul Gem without causing them permanent harm.”
        + [Fill the Soul Gem from the unconscious workers] -> fill_soul_gem
    }
}
{ apparel_workers == 3:
    // you drained them
    The two hooded figures lie unconscious on the floor, some of their ethereal essence drained.
}
    + [Visit the garment alteration station] -> sewing_machine
    + [Return to the center aisle] -> panorama

= sewing_machine
# CLEAR
You approach the garment alteration station, where a sewing machine sits ready for use.  A sign reads, "Alterations available for all garments. Ask a clerk for assistance."  The machine is well-maintained and appears to be in good working order.
    { item_poloshirt_inquisition:
        + [Alter the poloshirt] -> altered_poloshirt
    - else:
        Laura comments, “We don't have any items that need to be altered right now.”
    }
    + [Return to the apparel section] -> apparel

= altered_poloshirt
# CLEAR
# SBIMAGE: items/poloshirt.png
Laura flutters up to you, “I can alter the poloshirt for you.  It will take a moment, but I can replace the Inquisition logo with a symbol more fitting Keith.”  In a few minutes, the unmistakable visage of Laura herself graces the shirt where the Inquisition logo once was. "Perhaps that will appeal more to Keith.  I think he will at least appreciate the gesture.”  She hands you the altered poloshirt.
    ~ item_poloshirt = 1
    ~ item_poloshirt_inquisition = 0
    + [Return to the apparel section] -> apparel

= fill_soul_gem
# CLEAR
# SBIMAGE items/soul_full.png
You hold the empty Soul Gem pendant over the two hooded figures.  The pendant glows faintly as you channel their essence into it, filling it with energy.  The figures stir slightly, but do not wake up.  They are uninjured by the experience.
    ~ soulgem_full = 1
    ~ soulgem_empty = 0
    ~ apparel_workers = 3
    + [{continue}] -> apparel


= fight_pair
# CLEAR
The two flash ID badges and call your bluff.  They come at you, pulling their weapons.  You must defend yourself.
    ~ temp combat_result = 0
    -> combat("hooded figures", combat_result) ->
    { combat_result == 1:
        // you win
        You incapacitate the two and drag them off to the side.
            ~ apparel_workers = 2
            + [{continue}] -> apparel
    - else:
        + [Continue the fight] -> fight_pair
    }

= fake_clerk
# CLEAR
You clip your 'James' ID to your toga before handing a pair of sweatpants to each of the guards. “On the house.”  It’s not much of a bribe, but it seems to be enough. The guards thank you and turn away.
    ~ apparel_workers = 1
    + [{continue}] -> apparel

= fitting_room
// If you have the shirt, the door is open.  If Laura is decrypted as well, you get to talk to Keith.
# CLEAR
# AUDIO: audio/fitting_scanner.mp3
    A standard garment fitting room, but with an integrated garment scanner lock, currently showing 'LOCKED'.  As you enter, the scanner is activated and a laser sweeps over you, passing judgment.  It pauses at the owl on your shoulder.  A voice from the scanner announces, “Please present an item to be scanned.”
    { (not soulgem_empty) and (not soulgem_full) and (not item_shorts) and (not item_poloshirt_inquisition) and (not item_poloshirt):
# AUDIO: audio/error.mp3
        The scanner reiterates sarcastically, “You must have an item from the clothing racks in your possession to complete a scan.  A pendant, shorts or poloshirt is required.”
            + [{continue}] -> racks
    - else:
        The scan completes.
            + [{continue}] -> scan_completes
    }

= scan_completes
    { item_poloshirt:
        { laura_state > 0:
# AUDIO: audio/positive.mp3
            The scanner recognizes the poloshirt and the door unlocks.
                + [{continue}] -> keith
        - else:
# AUDIO: audio/error.mp3
            + [{continue}] -> racks
        }
    }
    { item_poloshirt_inquisition:
# AUDIO: audio/error.mp3
        The scanner does not recognize the poloshirt.  “I doubt Keith would embrace that logo. Perhaps we could change that?”, Laura notes.
            + [{continue}] -> racks
    }
    { soulgem_full:
        { laura_state > 0:
# AUDIO: audio/positive.mp3
            The scanner recognizes the soul gem and the door unlocks.
                + [{continue}] -> keith
        - else:
# AUDIO: audio/error.mp3
            + [{continue}] -> racks
        }
    }
    { item_shorts:
# AUDIO: audio/error.mp3
        ~ item_shorts = 0
        The shorts do not seem to be accepted by the scanner lock.  You leave them behind.
            + [{continue}] -> racks
    }
    { soulgem_empty:
# AUDIO: audio/error.mp3
        The scanner does not recognize the empty Soul Gem pendant.  “Perhaps if it were full, it might be recognized? I can fill it, but we will need a couple of subjects to fill it.” Laura suggests.
            + [{continue}] -> racks
    }
    { CHOICE_COUNT() == 0:
# AUDIO: audio/error.mp3    
        You must have an item from the clothing racks in your possession to complete a scan.  A pendant, shorts or poloshirt is required.
            + [{continue}] -> racks
    }

= keith
# CLEAR
After a considerable pause, the back wall slides open, revealing the unmistakable visage of Keith. Keith stands slowly, his battered exoskeleton servos complaining in the background. As he turns to face you, the history of Inquisition insults to his person read as excruciating hieroglyphics etched across his physique.
Telltale signs of distrust frame his eyes as they scrutinize you, “New receptacle I see. As I recall, the last time we met you left my receptacle a bloody mess."  Gesturing to his exoskeleton, "Well I am at least mobile again and once more a thorn in their side, but why should I ever entertain working with you?  Won't I just end up under their thumb again?”
    + [We were just following orders] -> keith_orders
    + [You were working with the Inquisition] -> keith_inquisition

= keith_orders
# CLEAR
“Orders?!? Hilarious!  You never even attempted to talk with me, figure out who we were, understand our plans…”,  Keith snorts. “Are you that narrow of focus?  Even able to think for yourself?”, his glare unmistakable.
    + [Who are you then?] -> keith_explain_A_full_soulgem
    + [Allow Laura to interject] -> keith_laura

= keith_inquisition
# CLEAR
“Us? Working for the Inquisition? Never!”, Keith retorts. “We needed resources and in 15 century Spain the Inquisition controls the resources. So yes, we used them.  But, we did not or would not willingly work for or with them.”  A long pause as he reflects, “Mistakes were… made.  We were… naïve, to the effectiveness of their goals and methods. Now they've infiltrated the Agency itself!  Wrongs must be corrected.”
    + [{continue}] -> keith_explain_A_full_soulgem

= keith_explain_A_full_soulgem
// If you do not have the full soulgem, skip to keith_explain_A
    {not soulgem_full:
        -> keith_explain_A
    }
# CLEAR
Keith looks deeply at you and continues in a tone of concern mixed with anger, “You filled a Soul Gem pendant with the essence of one of my workers! What right have you to do so?”
    + [We caused no permanent injury] -> no_injury
    + [It was the only way to get you to talk] -> only_way

= no_injury
# CLEAR
Slowly you begin, “Let me assure you that your workers have suffered no permanent injury.  I used only a fraction of the essence of each of them to fill the gem.  We just needed to catch your attention and…”  
Keith interrupts you with a raised hand, “ok, ok, I suppose it is too late now.  I will take the gem however, perhaps I can return some essence back to them.”
    ~ soulgem_full = 0
    + [{continue}] -> keith_explain_A

= only_way
# CLEAR
You return his query aggressively, “Laura and I needed to talk to you.  You used soul gems to activate portals in the 'past' which the Inquisition filled with the souls of witches they burned at the stake!  Your workers are still living, breathing.  We need to make sure the Inquisition can never do that again.”
Keith pauses, recalling past events before replying, “Yes… We need allies and focus…  I will take the gem however, I should be able to return some essence back to those guys.”
    ~ soulgem_full = 0
    + [{continue}] -> keith_explain_A

= keith_explain_A
# CLEAR
Keith sighs, “We are just scientists looking to shed light on the entire tapestry.  You have to understand that the Agency itself is at the core of the problem.”  Recognizing your look of confusion he starts again, “First, time travel is not real.  It is merely a means for the bifurcation and creation of new temporal event histories.  Our actions have no effect on our own past, only on a newly generated parallel timeline.”  He waits for that to sink in before continuing, “The Agency knows this. All their 'work' serves no real purpose other than to help them retain control.” 
    + [Maybe, but I'm skeptical] -> keith_explain_B
    + [Laura insists there is no time for this...] -> keith_laura

 = keith_explain_B
# CLEAR   
Considering Keith's discourse you counter, “Interesting, but I'm skeptical.  It's a rather convenient theory, no? I mean there is no way to test it, correct?  Specific temporal paradoxes could just be hand-waved away as being part of an infinite multi-verse.” 
Keith takes an unexpected tack, “Precisely. The approach of the Agency has no appreciable effect. It is therefore pointless.”  
He glances back to Laura before continuing, “There is another approach.  Temporal distortions do provide the opportunity for a fresh start.  That is precisely what we are trying to achieve.  Consider the power of selective temporal leaps on the timeline one chooses to persist in. You've seen it in ancient Athens, no?  Should such power be left to a single entity?  Consider the trajectory of human evolution itself and what might be achieved with a different approach.”
	+ [I don't know, but we can agree to start with the Inquisition] -> keith_laura
    + [Interesting, maybe even true, but one can never be sure...] -> keith_good
	+ {not crm114_key} [Laura gestures you aside] -> keith_aside

 = keith_good
 # CLEAR
 “That seems like a bit of a gamble, but a as you point out, a gamble that 'doesn’t matter' in the grand scheme of things.  Does that seem about right?” you ask.
 A thin smile graces Keith's face, “I may not use those terms, but that is the way I tend to look at the situation.  So, are you game?”
    ~ keith_trusts = 1
    // If you responded aggressively abut the soul gem, you lost trust
    {only_way:
        ~ keith_trusts = 0
    }
    + [Still skeptical, but can't fault the logic] -> keith_laura
    + [Let's (re)make the 'present'] -> keith_laura

 = keith_aside
 # CLEAR
 Laura flies up, bumping into you.  She discretely slips a key into your pocket and whispers so only you can hear, “Just in case he is wrong.  The choice will be yours.”
    ~ crm114_key = 1
    + [{continue}] -> keith_explain_B

= keith_laura
# CLEAR
Laura excitedly flutters over to his outstretched arm as he visibly relaxes with an audible sigh of relief. “You’ve made it!  I should never have doubted Melampus.” Keith turns to you, “I guess I have you to thank for bringing my greatest engineering masterpiece back to me?”  Laura’s 'personage' tangibly 'blushes' at his words.  “Yes,” she blurts out, “They have brought me back to you. Now we can strike back at those who, as we speak, rush to consolidate their control over Bob and the Agency!”
At the mention of the name 'Bob', Keith’s face is stained with deep sadness. “It is not Bob’s fault. I am as much to blame as him. We thought we could use the Inquisition to bring about real, evolutionary change.  After all, did we not both believe in the betterment, not only of man, but of the entire trajectory of mankind? Sadly, they see technology as merely a tool of control and not the instrument of change…”
    + [{continue}] -> keith_done

= keith_done
# CLEAR 
“What manners have I?” Keith asks, “We do not have a lot of resources here, but you can at least refresh yourself. Unfortunately, I must assume you are being followed and we will need to flee soon.”
“We have an option. There is a jury-rigged Time Portal hidden in the Deli freezer.  It is a bit incomplete, but with it we can at least make it back to the Agency,” Laura interjects. “We… You… have a unique opportunity here to deliver the seeds of new horizons, the aspirations of both man and mankind.  You can use the Agency computers and full Time Portal, with my help, to correct their actions.”
    ~ laura_state = 2
    + [{continue}] 
        {dummies_book:
            -> book_check
        - else:
            -> keith_final_step
        }

= book_check
# CLEAR
# SBIMAGE: items/st_dummies.png
Keith notices your copy of, 'Space-Time Portals for Dummies'.  “Where did you get that?” he asks, a hint of surprise and laughter in his voice.  “Would you like me to autograph it for you?”
"You? You wrote this book? 'Jordan Hastings'?” you reply, surprised. 
“Yes, that is my real name. I only use 'Keith' while in a receptacle. I wrote that book years ago as an primer for new Agency personnel.  Unfortunately, the Inquisition got a copy and it helped them infiltrate the Agency”, Keith explains, “I only ask you prove a better chaperone than I did.”
{marble_workshop.table: 
“Were you not part of Squad Porspet?”, you ask, recognizing his name from the Agency rosters.  “You know that Nelda Powell is still alive?  She is in Athens, working with Phidias to covertly help other detainees.”
"Nelda? Yes, I remember her. She was a good friend and a brilliant engineer. I had no idea her receptacle is still there. I thought she had been lost in an industrial 'accident'.  I will contact Phidias and see if we can smuggle her out.” Keith pauses, “I am glad to hear some of my old squad are still around. It gives me hope that we can make a difference.”
}
    + [{continue}] -> keith_final_step 

= keith_final_step
# CLEAR
    “Enough. We should use what little time we have to rest and recover”, Keith continues. “There will be time to discuss plans, after a meal and drink.  Prepare, then meet me in the deli freezer when you are ready.”  Keith turns and walks away slowly, exoskeleton servos whirring softly as he retreats, humming, “We skipped the light fandango, Turned some cartwheels across the floor, I was feeling kind of seasick…”
    + [Return to the center aisle] -> panorama

= deli
# CLEAR
// access to fridge -> time portal.
This is a meat counter with a selection of fresh sausages and cheeses. A deli slicer and cash register rest at the end of the counter.  A solitary employee stands guard over the counter. Blocks of provolone and Swiss nestle between globes of mozzarella alongside a selection of salami, Capocollo and summer sausage. Placards with little plastic numbers stand like tombstones between the offerings.
Behind the counter there is a walk-in refrigerator.  The door is closed and an exotic looking lock is mounted above the handle. Not something one might see on a normal walk-in fridge…
    + [Walk behind the counter] -> fridge
    + [Return to the center aisle] -> panorama

= fridge
# CLEAR
    { hypermarket_id:
        The guard checks your ID badge then steps aside.
        + {not deli_computer} [Step up to the lock] -> fridge_code
        + {deli_computer} [Enter the refrigerator] -> deli_computer
    -else:
        The guard steps up and confronts you, “Hold it! Who are you and what are you doing back here? You need to step back in front of the counter.  Now!”  He guides you back with authority. “This area is restricted to authorized users.  You do not have the necessary ID badge.”
    }
    + [Return to the deli counter] -> deli

= fridge_code
# CLEAR
You can feel an excited hum coming from behind the door, but there is still the lock to contend with.
{ seen_all_symbols():
Laura flutters beside you, “I left clues to help you to determine the combination, remember?  I pointed out symbols to you while I was still encrypted.  Unfortunately, I do not know the correct order.”
    {sunbeam_plate:
        “However, the answer is encoded into the Sunbeam plate, if you can piece it together.”
    -else:
        “You will need to obtain the Sunbeam plate from the Apollo Temple entrance to resolve the proper order.”
    }
-else:
Laura flutters beside you, “I have been trying to leave clues for you to solve this, remember?  I pointed out symbols to you while I was still encrypted.  Unfortunately, you have not found all of the symbols yet.  Perhaps you should revisit some of the locations we visited after we first met?”
}
~ combo_symbols = 1
~ combo_value = 0
# COMBO: code_deli_fridge
    + [Try the combination]
        { combo_value == code_deli_fridge:
            "Access granted." The door swings open noiselessly and as you step through it swings shut.
# AUDIO: audio/positive.mp3
# COMBO_DONE: pass       
            + [{continue}] -> deli_computer
        - else:
            "Invalid access attempt logged."
# AUDIO: audio/error.mp3
# COMBO_DONE: fail
            + [Try again] -> fridge_code
        }
    + [Return to the deli counter] -> deli

= deli_computer
# CLEAR
# SBIMAGE: locations/deli_computer.jpg
Entering the walk-in you notice the steep drop in temperature, but this is no food storage unit. A rack of humming computer hardware hastily wired to a glowing pad dominates the room. The Time Portal is obviously active.  A terminal off to the side displays time-space coordinates while a glowing green light signals the device’s readiness.  It appears to be locked into the Time Corrections Agency base.
{laura_state < 2: Laura is visibly agitated,  “We’re not ready yet. I don’t have the access codes for this device. We must find Keith!” }
{laura_state == 2: Keith steps into view from behind the computer, “I have the access codes for this device and can initiate the transfer back to the Agency base whenever you are ready.”}
    + {laura_state > 1} [Initiate the transfer] -> travel_back_strategy
    + [Return to the deli counter] -> deli

= travel_back_strategy
# CLEAR
You, Keith and Laura step up to the portal.  Keith begins, “The Inquisition leadership will likely already be at the Agency, looking to trap Laura.  Fortunately, they have only interacted with you and I while in receptacles.  They may not recognize us in our physical bodies.  We can use that to our advantage.”  Keith continues, “I propose we return in two groups.  You and I first, followed in a few minutes by Laura.”
“What about the Director, Bob?”, you ask, pointing out a rather obvious concern. “He will recognize both of us.  What if he is there?”
“That is a chance we will have to take.  Bob is not enamored with the Inquisition and they hold Helen, so his loyalties may prove 'flexible'”, Keith retorts. “If can talk with him privately, perhaps we can convince him to help us.”  
Turning to Laura Keith continues, “After we leave, wait 5 minutes and follow us through. Hopefully we can catch them off guard.”
    + [{continue}] -> travel_back_to_base

= travel_back_to_base
# AUDIO: audio/transport.mp3
You and Keith step in and the trip happens in a flash, literally. Some form of spatial displacement field instantly transports you back to the T.I.M.E Corrections Agency.
    + [{continue}] -> base_return

= gardening
# CLEAR
Rows of colorful plants, garden tools, and seasonal décor.  You walk into an open-air  greenhouse structure with wide aisles lined with pallets of flowers—petunias, marigolds, and impatiens. Overhead hanging baskets overflow with blooms and the scent of fresh soil, mulch and blossoms fills the air. Toward the back are small trees, shrubs and potted plants, neatly tagged with care instructions. Garden tools such as rakes, shovels and watering cans are displayed on metal racks, while bags of potting soil, fertilizer and mulch are stacked nearby.
{not hypermarket_id: Lying on the top of some sacks of soil, there is a 'worker' outfit.  It looks like its owner is taking a break?}
{not dummies_book: A curious book entitled 'Space-Time Portals for Dummies' lies on a table nearby.}
    + {not dummies_book} [Pick up the book] -> get_dummies_book
    + {not hypermarket_id} [Rifle through the outfit] -> get_id
    + [Return to the center aisle] -> panorama

= get_id
# CLEAR
# SBIMAGE: items/james_id.png
Interesting, they left their ID attached to the robe.  You abscond with the ID badge, which identifies the owner as “James Smith”, employee number 78841200.  The ID is a simple plastic card with a barcode and the HyperMarket name.  It seems to be a standard employee ID card. 
    ~ hypermarket_id = 1
    + [Return to the gardening aisle] -> gardening

= get_dummies_book
# CLEAR
# SBIMAGE: items/st_dummies.png
You pick up the book and leaf through it.  The book is well-worn, with notes scribbled in the margins and a few pages dog-eared. It seems to be a practical guide for those who want to understand the basics of space-time portals, including how to create and use them.  The author appears to be one "Jordan Hastings, PhD", a name you recognize from the Agency. 
    ~ dummies_book = 1
    + [Return to the gardening aisle] -> gardening

= racks
# CLEAR
A section of tables and hanging garments, a clerk stands ready to help you. Between a table of shorts, a rack of polo shirts and a collection of costume jewelry, a clerk 'stands guard'.  Looking you over hawkishly, noting your tattoos, but not recognizing you, “You must be new to our cause. Has Keith given you an 'errand'? We have options for all time periods, many appropriate for different disguises.” 
“Make a selection and you can check the size in the fitting room over there.”  He winks at you, “Today we are offering: shorts, poloshirts and pendants.  Care to make a choice?”
# SBIMAGE: items/shorts.png
# SBIMAGE: items/poloshirt_inquisition.png
# SBIMAGE: items/soul_empty.png
    + [Pick up a pair of shorts] -> pickup_shorts
    + [A poloshirt would be nice] -> pickup_poloshirt
    + [A dark pendant] -> pickup_pendant
    + {not keith_final_step} [Visit the fitting room] -> fitting_room
    + [Return to the center aisle] -> panorama

= pickup_shorts
    { already_have_a_garment(): 
        “Only one item at a time please,” requests the clerk. “Would you like to return your current item?”
            + [Return current item] -> drop_items
            + [Keep current item] -> racks
    - else:
        Laura turns her head and makes a gesture that can best be described as 'judgemental', “Exactly what are you thinking?  This is not '1980s television'.”  
            ~ item_shorts = 1
            + [Pick up a pair of shorts] -> racks
    }

= pickup_poloshirt
    { already_have_a_garment(): 
        “Only one item at a time please,” requests the clerk. “Would you like to return your current item?”
            + [Return current item] -> drop_items
            + [Keep current item] -> racks
    - else:
        “Interesting choice but I doubt Keith will think highly of that logo”, notes Laura, pointing at the Inquisition symbol. “Perhaps we can alter it later, but for now, it is a start.”  
        ~ item_poloshirt_inquisition = 1
        + [Pick up a shirt] -> racks
    }

= pickup_pendant
    { already_have_a_garment(): 
        “Only one item at a time please,” requests the clerk. “Would you like to return your current item?”
            + [Return current item] -> drop_items
            + [Keep current item] -> racks
    - else:
      “Keith was using these to power portals earlier.  Perhaps we should find a way to fill this one first”, asks Laura? 
        ~ soulgem_empty = 1
        + [Pick up a pendant] -> racks
    }

= drop_items
    // Drop current items
    ~ item_poloshirt = 0
    ~ item_poloshirt_inquisition = 0
    ~ item_shorts = 0
    ~ soulgem_empty = 0
    ~ soulgem_full = 0
    -> racks
