// Function called from Javascript to generate the HTML content
// of the 'Mission Log' panel.

=== function log_entry(title, detail)
    ~ return "<p style='margin:0px;'><b>&bull; {title}</b> - {detail}</p>"

=== function generate_log_html()
    ~ temp s = ""
    // Mausoleum workshop
    {workshop.transfer: 
        ~ s += log_entry("Mission start", "Begin the mission in Athens, Greece (450 BC).")
    }
    {workshop.owl: 
        ~ s += log_entry("Finding Laura", "Laura appears to be digitally trapped in a mechanical owl.")
    }
    {workshop.talk_with_helen: 
        ~ s += log_entry("Enter Helen", "Met Bob's wife, Helen in a mausoleum cell.")
    }
    // Garden
    {garden.garden_gate:
        ~ s += log_entry("Private Garden", "You visited the private garden.")
    }
    {garden.dish: 
        ~ s += log_entry("Garden dish", "You examine the dish and Laura points out: GLYPH6.")
    }
    {garden.servant: 
        ~ s += log_entry("Andrew remembers", "Andrew remembers the Spain mission.  He suggests you talk with Phidias.")
    }
    // Template
    {temple.panorama:
        ~ s += log_entry("Temple of Hephaestus", "You visited the Temple of Hephaestus.")
    }
    {helped_beggar:
        ~ s += log_entry("Aid the needy", "You help out a beggar in the Temple of Hephaestus.")
    }
    {temple.pronaos: 
        ~ s += log_entry("Crutches", "Laura seemed excited when she saw a crutch: GLYPH0.")
    }
    {stole_crutch:
        {crutch:
            ~ s += log_entry("Crutch thief", "You stole Aspasia's crutch.  People will talk. Perhaps you should return it to her?")
        -else:
            ~ s += log_entry("Ex-Crutch thief", "You stole Aspasia's crutch, but returned it to her.")
        }
    }
    {won_cella_fight:
        ~ s += log_entry("No fighting", "You intervene in a fight in the Temple of Hephaestus, defending another 'detainee'.")
    }
    {temple.melampus:
        ~ temp text = "You access the workshop of Melampus."
        {melampus_list:
            ~ text += " He gives you a list of items he needs to help Laura."
        }
        {antivirus:
            ~ text += " He writes an antivirus that can decode Laura's encryption."
        }
        ~ s += log_entry("Meet Melampus", text)
    }
    // Agora
    {agora.panorama:
        ~ s += log_entry("The agora", "You visited the agora of Athens.")
    }
    {tip_scales:
        ~ s += log_entry("Tipping the scales", "Laura created a bit of a scene at the food counter. During the commotion, she pointed out the scales: GLYPH2.")
    }
    {agora.beg:
        ~ s += log_entry("Looking for handouts", "You've reached the bottom of the barrel, begging for pity from wealthy diners.")
    }
    {agora.alley:
        ~ s += log_entry("Getting mugged", "The agora back alleys are not the friendliest.  Perhaps you will be more careful in the future?")
    }
    // Pnyx
    {pnyx.panorama:
        ~ s += log_entry("The Pnyx", "You visited the Pnyx.")
    }
    {pnyx.buy_it:
        ~ s += log_entry("Men in barrels", "You learn, first hand, the origin of the old proverb: 'never trust a man wearing a barrel.")
    }
    {pnyx.fava_skip:
        ~ s += log_entry("Philosopher's weakness", "You exploit an Achilles' heel of the followers of Pythagoras.")
    }
    {philosopher_win and not pnyx.fava_skip:
        ~ s += log_entry("Philosopher in training", "You pass a test of Pythagorean philosophical doctrine.")
    }
    // River
    {river.panorama:
        ~ s += log_entry("The Eridanos", "You reach the calming waters of the Eridanos.")
    }
    {river.bench:
        ~ s += log_entry("Hidden notes", "You obtained the keycode to the inner sanctum of the Temple of Apollo under the riverbank bench.")
    }
     {apollo_and_daphne:
        {river.victory:
            ~ s += log_entry("Statue of Apollo", "You bested Apollo in combat. For a battery?")        
        -else:
            ~ s += log_entry("The lovers", "Your intervention in the lovers' spat leads to the creation of one of history's greatest statues.")
        }
    }
    // Phidias' workshop
    {marble_workshop.panorama:
        ~ s += log_entry("Phidias' workshop", "You visit the famous marble workshop of Phidias.")
    }
    {marble_workshop.table:
        ~ s += log_entry("Introducing Nelda", "Phidias is repairing the receptacle of Nelda Powell, an agency colleague persecuted by the Inquisition.")
    }
    {anthropoid_gear:
        ~ s += log_entry("Gears of change", "While visiting Nelda, Laura seemed preoccupied by the anthropoid gear: GLYPH8.")
    }
    {door_to_oracle_code:
        ~ s += log_entry("Phidias' confidence", "You have sought out and obtained the confidence of Phidias.  He has agreed to help you.")
    }
    // Temple of Apollo Entrance
    {apollo.panorama:
        ~ s += log_entry("The Temple of Apollo", "You travel to the Temple of Apollo.")
    }
    {sunbeam_plate:
        ~ s += log_entry("Plate of the Sun", "The sunbeam plate is in your possession.  Laura was rather adamant that its acquisition was critical.")
    }
    {apollo.pythia:
        ~ s += log_entry("Meeting Pythia", "The high priestess of the Temple of Apollo greets you with a foreboding vision.")
    }
    // Temple of Apollo Backroom
    {apollo_backroom.writers:
        ~ s += log_entry("Writers of antiquity", "The old stories of the Greek gods are the work of public relations writer in the Temple of Apollo.")
    }
    {apollo_backroom.read_future:
        ~ s += log_entry("Peering into the future", "The Pythia has read your future.  A future path that you must choose.")
    }
    // Computer room
    {computer_room.panorama:
        ~ s += log_entry("Grigori awaits", "You have access to the powerful computer systems in the Temple of Apollo.")
    }
    {computer_room.decode_laura:
        ~ s += log_entry("Freedom for Laura", "Using the Grigori computer and Melampus' antivirus, you free Laura from her digital chains.")
    }
    // Hypermarket
    {hypermarket.panorama:
        ~ s += log_entry("The HyperMarket", "You travel to a modern large box store.")
    }
    {dummies_book:
        ~ s += log_entry("Bookworm", "Maybe you can build your own portal now? Curious reading seems to follow you around.")
    }
    {hypermarket.fight_pair:
        ~ s += log_entry("Queensberry Rules", "You best the apparel workers.  What will Keith think?")
    }         
    {hypermarket.keith:
        ~ s += log_entry("Meeting Keith", "After finding an item that intrigues him, you meet Keith via the HyperMarket fitting room.")
    }
    {hypermarket.deli_computer:
        ~ s += log_entry("Heading 'home'?", "You make your way to the Time Portal located in the HyperMarket deli freezer.")
    }
    {hypermarket.travel_back_strategy:
        ~ s += log_entry("Plans in motion", "You are prepared for your return to the Time Corrections Agency.")
    }
    // Return to the Base
    {base_return.base_start:
        ~ s += log_entry("Time Corrections Agency", "You return to the Time Corrections Agency headquarters (2413 AD) where your mission began.")
    }
    {base_return.bob:
        ~ temp bobtext = "Covertly, you bring Bob up to speed on the situation."
        {base_return.bob_helen and workshop.talk_with_helen:
            ~ bobtext += " He helps you out by improving your credentials."
        }
        ~ s += log_entry("Bob on your side", bobtext)
    }
    {base_return.leader:
        ~ s += log_entry("Inquisitor cometh", "Agent Daniel Hickman has been working as the head of the Inquisition.")
    }
    {base_return.prof:
        ~ s += log_entry("On the precipice", "Dr Hastings' grand plan is nearly complete.")
    }
    // Endings
    {normal.chip: 
        ~ s += log_entry("Mission complete", "The agency has been restored. Laura is back in place, the status quo re-established.")
    }
    {ascension.cottage: 
        ~ s += log_entry("Mission complete", "Laura's transformation is complete.  Dr Hastings' vision has been realized.  A new era begins.")
    }
    {control.suit: 
        ~ s += log_entry("Mission complete", "At long last the scorn of AI has been overcome!  The Inquisition takes its rightful place.")
    }
    ~ return s
